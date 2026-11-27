import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../../common/pagination/index.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import {
  NotificationType,
  type Notification,
  Post,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  User,
} from '../../mongo/models.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  AdminPostReportDto,
  PostReportDto,
  ReportDecision,
} from '../dto/post-interaction.dto.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import type { CreatePostWithEvidenceReportDto } from '../dto/post-interaction.dto.js';
import type { AdminPostReportsQueryDto } from '../dto/admin-post-reports-query.dto.js';
import { PostReportEvidenceService } from './post-report-evidence.service.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { lockDocument } from '../../mongo/document-lock.js';

const toAuthor = (user: User) => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  avatarUrl: user.avatarUrl,
  isProfessional: user.isProfessional,
});

function toReportDto(report: PostReport): PostReportDto {
  return {
    id: report.id,
    postId: report.postId,
    reason: report.reason,
    details: report.details,
    status: report.status,
    createdAt: report.createdAt,
  };
}

const EXCERPT_LENGTH = 80;

export interface PostRemovalNotice {
  postId: string;
  authorId: string;
  reporterIds: string[];
  reason: PostReportReason | null;
  excerpt: string | null;
}

function excerptOf(post: Post): string | null {
  const text = (post.blog?.title || post.body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > EXCERPT_LENGTH
    ? `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`
    : text;
}

function topReason(reports: PostReport[]): PostReportReason | null {
  const counts = new Map<PostReportReason, number>();
  for (const { reason } of reports) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let top: PostReportReason | null = null;
  for (const [reason, count] of counts) {
    if (top === null || count > (counts.get(top) ?? 0)) top = reason;
  }
  return top;
}

@Injectable()
export class PostReportsService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostReport.name)
    private readonly reports: Model<PostReport>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationsService,
    private readonly evidence: PostReportEvidenceService,
    private readonly mongo: MongoService,
  ) {}

  async create(
    postId: string,
    reporterId: string,
    dto: CreatePostWithEvidenceReportDto,
  ): Promise<PostReportDto> {
    await this.assertReportable(postId, reporterId);
    try {
      const fields = {
        postId,
        reporterId,
        reason: dto.reason,
        details: dto.details || null,
        status: PostReportStatus.PENDING,
      };
      const ids = dto.evidenceIds ?? [];
      const report = ids.length
        ? await this.mongo.withTransaction(async (session) => {
            await lockDocument(this.mongo, session, 'post', postId);
            await this.assertReportable(postId, reporterId, session);
            const [created] = await this.reports.create([fields], { session });
            await this.evidence.attach(
              session,
              reporterId,
              postId,
              created.id,
              ids,
            );
            return created;
          })
        : await this.reports.create(fields);
      return toReportDto(report);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      throw new StateConflictException(
        'ALREADY_REPORTED',
        'You have already reported this post',
      );
    }
  }

  async assertReportable(
    postId: string,
    reporterId: string,
    session?: ClientSession,
  ) {
    const post = await this.posts
      .findOne({ _id: postId, status: PostStatus.PUBLISHED })
      .select('authorId')
      .session(session ?? null)
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    if (post.authorId === reporterId) {
      throw new InvalidInputException(
        'OWN_POST',
        'You cannot report your own post',
      );
    }
    const reported = await this.reports
      .exists({ postId, reporterId })
      .session(session ?? null)
      .exec();
    if (reported) {
      throw new StateConflictException(
        'ALREADY_REPORTED',
        'You have already reported this post',
      );
    }
  }

  async findAll(
    query: AdminPostReportsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostReportDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.postId ? { postId: query.postId } : {}),
    };
    const [rows, totalItems] = await Promise.all([
      this.reports
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.reports.countDocuments(filter).exec(),
    ]);
    return createPaginatedResponse(
      await this.toAdminDtos(rows),
      totalItems,
      query,
    );
  }

  async review(
    id: string,
    reviewerId: string,
    status: ReportDecision,
  ): Promise<AdminPostReportDto> {
    const decided = await this.reports
      .findOneAndUpdate(
        { _id: id, status: PostReportStatus.PENDING },
        { $set: { status, reviewedById: reviewerId, reviewedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .exec();
    const report = decided ?? (await this.reports.findOne({ _id: id }).exec());
    if (!report)
      throw new ResourceNotFoundException('NOT_FOUND', 'Report not found');
    if (!decided) {
      throw new StateConflictException(
        'CONFLICT',
        'The report was already reviewed',
      );
    }
    await this.notifications.notify({
      recipientId: report.reporterId,
      type:
        status === PostReportStatus.RESOLVED
          ? NotificationType.REPORT_RESOLVED
          : NotificationType.REPORT_DISMISSED,
      postId: report.postId,
      reason: report.reason,
    });
    const [dto] = await this.toAdminDtos([report]);
    return dto;
  }

  async removalNotice(
    postId: string,
    session?: ClientSession,
  ): Promise<PostRemovalNotice | null> {
    const post = await this.posts
      .findOne({ _id: postId })
      .select('authorId body blog.title')
      .session(session ?? null)
      .exec();
    if (!post) return null;
    const reports = await this.reports
      .find({ postId })
      .select('reporterId reason')
      .session(session ?? null)
      .exec();
    return {
      postId,
      authorId: post.authorId,
      reporterIds: [
        ...new Set(reports.map(({ reporterId }) => reporterId)),
      ].filter((id) => id !== post.authorId),
      reason: topReason(reports),
      excerpt: excerptOf(post),
    };
  }

  async resolvePendingForPost(
    session: ClientSession,
    postId: string,
    adminId: string,
    now: Date,
  ): Promise<void> {
    await this.reports
      .updateMany(
        { postId, status: PostReportStatus.PENDING },
        {
          $set: {
            status: PostReportStatus.RESOLVED,
            reviewedById: adminId,
            reviewedAt: now,
          },
        },
        { session },
      )
      .exec();
  }

  async storeRemovalNotifications(
    notice: PostRemovalNotice,
    session: ClientSession,
    reasonOverride?: string | null,
  ): Promise<Notification[]> {
    const note = notice.excerpt ?? undefined;
    return this.notifications.storeSystemNotifications(
      [
        {
          recipientId: notice.authorId,
          type: NotificationType.POST_REMOVED,
          postId: notice.postId,
          reason: reasonOverride ?? notice.reason ?? undefined,
          note,
        },
        ...notice.reporterIds.map((recipientId) => ({
          recipientId,
          type: NotificationType.REPORTED_POST_REMOVED,
          note,
        })),
      ],
      session,
    );
  }

  private async toAdminDtos(
    reports: PostReport[],
  ): Promise<AdminPostReportDto[]> {
    const counts = await this.reports
      .aggregate<{ _id: string; total: number; pending: number }>([
        {
          $match: {
            postId: {
              $in: [...new Set(reports.map((report) => report.postId))],
            },
          },
        },
        {
          $group: {
            _id: '$postId',
            total: { $sum: 1 },
            pending: {
              $sum: {
                $cond: [{ $eq: ['$status', PostReportStatus.PENDING] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();
    const countsByPost = new Map(counts.map((row) => [row._id, row]));
    const evidenceByReport = await this.evidence.forReports(
      reports.map((report) => report.id),
    );
    const [posts, reporters] = await Promise.all([
      this.posts
        .find({
          _id: { $in: [...new Set(reports.map(({ postId }) => postId))] },
        })
        .exec(),
      this.users
        .find({
          _id: {
            $in: [...new Set(reports.map(({ reporterId }) => reporterId))],
          },
        })
        .exec(),
    ]);
    const authors = await this.users
      .find({
        _id: { $in: [...new Set(posts.map(({ authorId }) => authorId))] },
      })
      .exec();
    const authorById = new Map(authors.map((user) => [user.id, user]));
    const postById = new Map(posts.map((post) => [post.id, post]));
    const reporterById = new Map(reporters.map((user) => [user.id, user]));
    return reports.flatMap((report) => {
      const post = postById.get(report.postId);
      const reporter = reporterById.get(report.reporterId);
      const author = post && authorById.get(post.authorId);
      if (!post || !reporter || !author) return [];
      return [
        {
          ...toReportDto(report),
          evidence: evidenceByReport.get(report.id) ?? [],
          reportCount: countsByPost.get(report.postId)?.total ?? 0,
          pendingReportCount: countsByPost.get(report.postId)?.pending ?? 0,
          reviewedAt: report.reviewedAt,
          reporter: toAuthor(reporter),
          post: { id: post.id, body: post.body, author: toAuthor(author) },
        },
      ];
    });
  }
}
