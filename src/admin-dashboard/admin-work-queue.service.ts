import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import {
  CommentReport,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  Post,
  PostReport,
  PostReportStatus,
  PostStatus,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  VerificationRequest,
  VerificationStatus,
  Workspace,
} from '../mongo/models.js';
import { runtimeConfig } from '../config/runtime-config.js';
import {
  AdminWorkQueueDto,
  type AdminWorkItemDto,
  type AdminWorkKind,
} from './dto/work-queue.dto.js';

type Count = { count: number };
type RawItem = {
  id: string;
  title: string | null;
  createdAt: Date | null;
  sourceCount: number;
  held?: boolean;
};
type Facet = {
  total: Count[];
  oldest: RawItem[];
  overlap?: Count[];
  appeals?: Count[];
  assigned?: Count[];
};
const LIMIT = runtimeConfig.ADMIN_WORK_PREVIEW_LIMIT;
const TIMEOUT = runtimeConfig.ADMIN_WORK_QUERY_TIMEOUT_MS;
const pending = { status: PostReportStatus.PENDING };

function items(kind: AdminWorkKind, rows: RawItem[]): AdminWorkItemDto[] {
  return rows.map((row) => ({
    kind,
    id: row.id,
    title: (row.title?.replace(/\s+/g, ' ').trim() || 'Chưa có tiêu đề').slice(
      0,
      runtimeConfig.ADMIN_WORK_TITLE_MAX_LENGTH,
    ),
    createdAt: row.createdAt ?? null,
    sourceCount: row.sourceCount,
  }));
}
const count = (rows?: Count[]) => rows?.[0]?.count ?? 0;

@Injectable()
export class AdminWorkQueueService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostReport.name) private readonly reports: Model<PostReport>,
    @InjectModel(CommentReport.name)
    private readonly comments: Model<CommentReport>,
    @InjectModel(VerificationRequest.name)
    private readonly verification: Model<VerificationRequest>,
    @InjectModel(Workspace.name) private readonly workspaces: Model<Workspace>,
    @InjectModel(SupportTicket.name)
    private readonly support: Model<SupportTicket>,
    @InjectModel(KnowledgeDocument.name)
    private readonly knowledge: Model<KnowledgeDocument>,
  ) {}

  private async simple<T>(
    model: Model<T>,
    match: Record<string, unknown>,
    title: unknown,
    date = 'createdAt',
    extra: Record<string, PipelineStage.FacetPipelineStage[]> = {},
  ) {
    const [result] = await model
      .aggregate<Facet>([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'count' }],
            oldest: [
              { $sort: { [date]: 1, _id: 1 } },
              { $limit: LIMIT },
              {
                $project: {
                  _id: 0,
                  id: '$_id',
                  title,
                  createdAt: '$' + date,
                  sourceCount: { $literal: 1 },
                },
              },
            ],
            ...extra,
          },
        },
      ])
      .option({ maxTimeMS: TIMEOUT })
      .exec();
    return result;
  }

  private async reportedPosts() {
    const [result] = await this.reports
      .aggregate<Facet>([
        { $match: pending },
        {
          $group: {
            _id: '$postId',
            createdAt: { $min: '$createdAt' },
            sourceCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: this.posts.collection.name,
            localField: '_id',
            foreignField: '_id',
            as: 'post',
          },
        },
        { $unwind: '$post' },
        {
          $facet: {
            total: [{ $count: 'count' }],
            overlap: [
              { $match: { 'post.status': PostStatus.PENDING_REVIEW } },
              { $count: 'count' },
            ],
            oldest: [
              { $match: { 'post.status': { $ne: PostStatus.PENDING_REVIEW } } },
              { $sort: { createdAt: 1, _id: 1 } },
              { $limit: LIMIT },
              {
                $project: {
                  _id: 0,
                  id: '$_id',
                  title: { $ifNull: ['$post.blog.title', '$post.body'] },
                  createdAt: 1,
                  sourceCount: 1,
                  held: { $eq: ['$post.status', PostStatus.PENDING_REVIEW] },
                },
              },
            ],
          },
        },
      ])
      .option({ maxTimeMS: TIMEOUT })
      .exec();
    return result;
  }

  private async reportedComments() {
    const [result] = await this.comments
      .aggregate<Facet>([
        { $match: pending },
        { $sort: { createdAt: 1, _id: 1 } },
        {
          $group: {
            _id: '$commentId',
            id: { $first: '$_id' },
            title: { $first: '$bodySnapshot' },
            createdAt: { $min: '$createdAt' },
            sourceCount: { $sum: 1 },
          },
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            oldest: [
              { $sort: { createdAt: 1, _id: 1 } },
              { $limit: LIMIT },
              {
                $project: {
                  _id: 0,
                  id: 1,
                  title: 1,
                  createdAt: 1,
                  sourceCount: 1,
                },
              },
            ],
          },
        },
      ])
      .option({ maxTimeMS: TIMEOUT })
      .exec();
    return result;
  }

  async get(adminId: string): Promise<AdminWorkQueueDto> {
    const [
      posts,
      reports,
      comments,
      verification,
      workspaces,
      support,
      knowledge,
    ] = await Promise.all([
      this.simple(
        this.posts,
        { status: PostStatus.PENDING_REVIEW },
        { $ifNull: ['$blog.title', '$body'] },
      ),
      this.reportedPosts(),
      this.reportedComments(),
      this.simple(
        this.verification,
        { status: VerificationStatus.PENDING },
        { $literal: 'Yêu cầu xác minh chuyên gia' },
      ),
      this.simple(
        this.workspaces,
        { status: VerificationStatus.PENDING },
        '$name',
      ),
      this.simple(
        this.support,
        { status: SupportTicketStatus.OPEN },
        { $concat: ['$code', ': ', '$subject'] },
        'lastMessageAt',
        {
          appeals: [
            { $match: { category: SupportTicketCategory.CONTENT_APPEAL } },
            { $count: 'count' },
          ],
          assigned: [{ $match: { assigneeId: adminId } }, { $count: 'count' }],
        },
      ),
      this.simple(
        this.knowledge,
        { status: KnowledgeDocumentStatus.AWAITING_REVIEW },
        '$title',
      ),
    ]);
    const counts = {
      POST_REVIEW: count(posts.total),
      POST_REPORTS: count(reports.total),
      COMMENT_REPORTS: count(comments.total),
      VERIFICATION: count(verification.total),
      WORKSPACES: count(workspaces.total),
      SUPPORT: count(support.total),
      KNOWLEDGE: count(knowledge.total),
    };
    const badges = {
      moderation:
        counts.POST_REVIEW +
        counts.POST_REPORTS -
        count(reports.overlap) +
        counts.COMMENT_REPORTS,
      verification: counts.VERIFICATION,
      workspaces: counts.WORKSPACES,
      support: counts.SUPPORT,
      knowledge: counts.KNOWLEDGE,
    };
    // A post awaiting review and also reported is a single moderation item.
    const combined = [
      ...items('POST_REVIEW', posts.oldest),
      ...items(
        'POST_REPORTS',
        reports.oldest.filter((row) => !row.held),
      ),
      ...items('COMMENT_REPORTS', comments.oldest),
      ...items('VERIFICATION', verification.oldest),
      ...items('WORKSPACES', workspaces.oldest),
      ...items('SUPPORT', support.oldest),
      ...items('KNOWLEDGE', knowledge.oldest),
    ].sort(
      (a, b) =>
        (a.createdAt?.getTime() ?? Infinity) -
          (b.createdAt?.getTime() ?? Infinity) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
    return {
      generatedAt: new Date(),
      refreshAfterSeconds: runtimeConfig.ADMIN_WORK_REFRESH_SECONDS,
      previewLimit: LIMIT,
      counts,
      badges: {
        ...badges,
        total: Object.values(badges).reduce((sum, n) => sum + n, 0),
      },
      support: {
        appeals: count(support.appeals),
        assignedToMe: count(support.assigned),
      },
      items: combined.slice(0, LIMIT),
    };
  }
}
