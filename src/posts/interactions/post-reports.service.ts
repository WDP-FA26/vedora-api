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
  Post,
  PostReport,
  PostReportStatus,
  PostStatus,
  User,
} from '../../mongo/models.js';
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

@Injectable()
export class PostReportsService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostReport.name)
    private readonly reports: Model<PostReport>,
    @InjectModel(User.name) private readonly users: Model<User>,
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
    // Conditional, so two admins can't both decide the same report.
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
    const [dto] = await this.toAdminDtos([report]);
    return dto;
  }

  /** Adds the reporter and the reported post with its author. */
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
