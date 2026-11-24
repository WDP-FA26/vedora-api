import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { assertAccountActive } from '../../auth-core/account-access.js';
import { AccessDeniedException } from '../../common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
} from '../../common/pagination/index.js';
import {
  CommentReport,
  Post,
  PostComment,
  PostReportStatus,
  PostStatus,
  User,
  UserRole,
} from '../../mongo/models.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { withUserLocks } from '../../mongo/with-user-locks.js';
import {
  AdminCommentReportDto,
  CommentReportDto,
  ReviewCommentReportDto,
} from '../dto/comment-report.dto.js';
import {
  CreatePostReportDto,
  PostReportsQueryDto,
} from '../dto/post-interaction.dto.js';

const toAuthor = (user: User) => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  avatarUrl: user.avatarUrl,
  isProfessional: user.isProfessional,
});

const toReport = (row: CommentReport): CommentReportDto => ({
  id: row.id,
  postId: row.postId,
  commentId: row.commentId,
  reason: row.reason,
  details: row.details,
  status: row.status,
  createdAt: row.createdAt,
});

@Injectable()
export class CommentReportsService {
  constructor(
    @InjectModel(CommentReport.name)
    private readonly reports: Model<CommentReport>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
  ) {}

  async create(
    postId: string,
    commentId: string,
    reporterId: string,
    dto: CreatePostReportDto,
  ): Promise<CommentReportDto> {
    return withUserLocks(this.mongo, [reporterId], async (session) => {
      await this.requireActor(reporterId, session);
      const post = await this.posts
        .findOneAndUpdate(
          { _id: postId, status: PostStatus.PUBLISHED },
          { $inc: { commentRevision: 1 } },
          { returnDocument: 'after', session, timestamps: false },
        )
        .exec();
      if (!post)
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      // Fence edits/deletions while taking the evidence snapshot, without marking the comment edited.
      const comment = await this.comments
        .findOneAndUpdate(
          { _id: commentId, postId },
          { $inc: { threadRevision: 1 } },
          { returnDocument: 'after', session, timestamps: false },
        )
        .exec();
      if (!comment)
        throw new ResourceNotFoundException('NOT_FOUND', 'Comment not found');
      if (comment.authorId === reporterId)
        throw new InvalidInputException(
          'OWN_COMMENT',
          'You cannot report your own comment',
        );
      const existing = await this.reports
        .exists({ commentId, reporterId })
        .session(session);
      if (existing)
        throw new StateConflictException(
          'ALREADY_REPORTED',
          'You have already reported this comment',
        );
      const author = await this.users
        .findById(comment.authorId)
        .session(session)
        .exec();
      if (!author)
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Comment author not found',
        );
      const [row] = await this.reports.create(
        [
          {
            postId,
            commentId,
            reporterId,
            reason: dto.reason,
            details: dto.details || null,
            parentId: comment.parentId ?? null,
            bodySnapshot: comment.body,
            authorSnapshot: toAuthor(author),
            status: PostReportStatus.PENDING,
          },
        ],
        { session },
      );
      return toReport(row);
    });
  }

  async findAll(query: PostReportsQueryDto) {
    const { skip, take } = getPaginationArgs(query);
    const filter = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.reports
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.reports.countDocuments(filter).exec(),
    ]);
    return createPaginatedResponse(await this.toAdminDtos(rows), total, query);
  }

  async review(
    id: string,
    adminId: string,
    dto: ReviewCommentReportDto,
  ): Promise<AdminCommentReportDto> {
    const row = await withUserLocks(this.mongo, [adminId], async (session) => {
      await this.requireActor(adminId, session, true);
      const report = await this.reports.findById(id).session(session).exec();
      if (!report)
        throw new ResourceNotFoundException('NOT_FOUND', 'Report not found');
      if (report.status !== PostReportStatus.PENDING)
        throw new StateConflictException(
          'CONFLICT',
          'The report was already reviewed',
        );
      const now = new Date();
      if (dto.action === 'DISMISS') {
        return (await this.reports
          .findOneAndUpdate(
            { _id: id, status: PostReportStatus.PENDING },
            {
              $set: {
                status: PostReportStatus.DISMISSED,
                action: 'DISMISSED',
                reviewedById: adminId,
                reviewedAt: now,
              },
            },
            { returnDocument: 'after', session },
          )
          .exec())!;
      }
      // Shares the same post write fence as reply/edit/delete, so no new child can escape a root removal.
      await this.posts.updateOne(
        { _id: report.postId },
        { $inc: { commentRevision: 1 } },
        { session, timestamps: false },
      );
      const comment = await this.comments
        .findOne({ _id: report.commentId, postId: report.postId })
        .session(session)
        .exec();
      const affected = comment
        ? await this.comments
            .find(
              comment.parentId
                ? { _id: comment.id, postId: report.postId }
                : {
                    postId: report.postId,
                    $or: [{ _id: comment.id }, { parentId: comment.id }],
                  },
            )
            .select('_id')
            .session(session)
            .exec()
        : [];
      const ids = [
        ...new Set([report.commentId, ...affected.map((item) => item.id)]),
      ];
      if (comment) {
        // Existing schema middleware cascades replies, notifications and reply-to references.
        await this.comments
          .deleteOne({ _id: comment.id, postId: report.postId }, { session })
          .exec();
      }
      await this.reports
        .updateMany(
          {
            postId: report.postId,
            commentId: { $in: ids },
            status: PostReportStatus.PENDING,
          },
          {
            $set: {
              status: PostReportStatus.RESOLVED,
              action: comment ? 'REMOVED' : 'ALREADY_REMOVED',
              reviewedById: adminId,
              reviewedAt: now,
            },
          },
          { session },
        )
        .exec();
      return (await this.reports.findById(id).session(session).exec())!;
    });
    const [result] = await this.toAdminDtos([row]);
    return result;
  }

  private async requireActor(
    id: string,
    session: ClientSession,
    admin = false,
  ) {
    const user = await this.users.findById(id).session(session).exec();
    if (!user)
      throw new ResourceNotFoundException('NOT_FOUND', 'Account not found');
    assertAccountActive(user.status);
    if (admin && user.role !== UserRole.ADMIN)
      throw new AccessDeniedException('FORBIDDEN', 'Admin access required');
    return user;
  }

  private async toAdminDtos(
    rows: CommentReport[],
  ): Promise<AdminCommentReportDto[]> {
    if (!rows.length) return [];
    const [users, comments, posts, counts] = await Promise.all([
      this.users.find({ _id: { $in: rows.map((r) => r.reporterId) } }).exec(),
      this.comments.find({ _id: { $in: rows.map((r) => r.commentId) } }).exec(),
      this.posts
        .find({
          _id: { $in: rows.map((r) => r.postId) },
          status: PostStatus.PUBLISHED,
        })
        .select('_id')
        .exec(),
      this.comments
        .aggregate<{ _id: string; count: number }>([
          {
            $match: {
              parentId: {
                $in: rows.filter((r) => !r.parentId).map((r) => r.commentId),
              },
            },
          },
          { $group: { _id: '$parentId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const postIds = new Set(posts.map((p) => p.id));
    const countById = new Map(counts.map((c) => [c._id, c.count]));
    return rows.map((row) => {
      const reporter = userById.get(row.reporterId);
      const comment = commentById.get(row.commentId);
      return {
        ...toReport(row),
        reviewedAt: row.reviewedAt,
        reviewedById: row.reviewedById,
        action: row.action,
        reporter: reporter ? toAuthor(reporter) : null,
        postAvailable: postIds.has(row.postId),
        comment: {
          id: row.commentId,
          parentId: row.parentId,
          body: row.bodySnapshot,
          author: row.authorSnapshot,
          currentBody: comment?.body ?? null,
          isAvailable: Boolean(comment),
          replyCount: countById.get(row.commentId) ?? 0,
        },
      };
    });
  }
}
