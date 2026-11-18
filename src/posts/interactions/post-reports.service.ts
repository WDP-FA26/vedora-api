import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../../common/pagination/index.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import {
  NotificationType,
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
  CreatePostReportDto,
  PostReportDto,
  PostReportsQueryDto,
  ReportDecision,
} from '../dto/post-interaction.dto.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';

const toAuthor = (user: User) => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  avatarUrl: user.avatarUrl,
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

/** Who to tell once an admin deletes a post; read before the post is gone. */
export interface PostRemovalNotice {
  authorId: string;
  reporterIds: string[];
  /** The most reported reason, or null when nobody reported the post. */
  reason: PostReportReason | null;
  /** The blog title or the start of the post text, so people know which post. */
  excerpt: string | null;
}

function excerptOf(post: Post): string | null {
  const text = (post.blog?.title || post.body || '').replace(/\s+/g, ' ').trim();
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
  ) {}

  async create(
    postId: string,
    reporterId: string,
    dto: CreatePostReportDto,
  ): Promise<PostReportDto> {
    const post = await this.posts
      .findOne({ _id: postId, status: PostStatus.PUBLISHED })
      .select('authorId')
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    if (post.authorId === reporterId) {
      throw new InvalidInputException(
        'OWN_POST',
        'You cannot report your own post',
      );
    }
    try {
      const report = await this.reports.create({
        postId,
        reporterId,
        reason: dto.reason,
        details: dto.details || null,
        status: PostReportStatus.PENDING,
      });
      return toReportDto(report);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      throw new StateConflictException(
        'ALREADY_REPORTED',
        'You have already reported this post',
      );
    }
  }

  async findAll(
    query: PostReportsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostReportDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter = query.status ? { status: query.status } : {};
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

  /**
   * Reads who to tell about an admin deleting a post. Call it before the
   * delete: the post's reports and notifications are removed with it.
   */
  async removalNotice(postId: string): Promise<PostRemovalNotice | null> {
    const post = await this.posts
      .findOne({ _id: postId })
      .select('authorId body blog.title')
      .exec();
    if (!post) return null;
    const reports = await this.reports
      .find({ postId })
      .select('reporterId reason')
      .exec();
    return {
      authorId: post.authorId,
      reporterIds: [
        ...new Set(reports.map(({ reporterId }) => reporterId)),
      ].filter((id) => id !== post.authorId),
      reason: topReason(reports),
      excerpt: excerptOf(post),
    };
  }

  /**
   * Tells the author their post was removed and every reporter that the post
   * they reported is gone. The post no longer exists, so the notifications
   * carry no `postId`, only the excerpt in `note`.
   */
  async announceRemoval(
    notice: PostRemovalNotice,
    adminId: string,
  ): Promise<void> {
    const note = notice.excerpt ?? undefined;
    const sends: Promise<void>[] = notice.reporterIds.map((recipientId) =>
      this.notifications.notify({
        recipientId,
        type: NotificationType.REPORTED_POST_REMOVED,
        note,
      }),
    );
    // An admin deleting their own post needs no notice.
    if (notice.authorId !== adminId) {
      sends.push(
        this.notifications.notify({
          recipientId: notice.authorId,
          type: NotificationType.POST_REMOVED,
          reason: notice.reason ?? undefined,
          note,
        }),
      );
    }
    await Promise.all(sends);
  }

  private async toAdminDtos(
    reports: PostReport[],
  ): Promise<AdminPostReportDto[]> {
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
          reviewedAt: report.reviewedAt,
          reporter: toAuthor(reporter),
          post: { id: post.id, body: post.body, author: toAuthor(author) },
        },
      ];
    });
  }
}
