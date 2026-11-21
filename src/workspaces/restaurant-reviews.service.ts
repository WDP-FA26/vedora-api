import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { assertAccountActive } from '../auth-core/account-access.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
} from '../common/pagination/index.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  AccountStatus,
  RestaurantReview,
  User,
  VerificationStatus,
  Workspace,
  WorkspaceMember,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { rethrowAsStateConflict } from '../mongo/unique-conflict.js';
import {
  ListRestaurantReviewsQueryDto,
  type RestaurantRatingBreakdownDto,
  type RestaurantReviewAuthorDto,
  type RestaurantReviewDto,
  type RestaurantReviewMutationResponseDto,
  type RestaurantReviewPageDto,
  type RestaurantReviewSort,
  type RestaurantReviewSummaryDto,
  UpsertRestaurantReviewDto,
} from './dto/restaurant-review.dto.js';

export interface RestaurantRatingStats {
  averageRating: number | null;
  reviewCount: number;
}

const emptyBreakdown = (): RestaurantRatingBreakdownDto => ({
  '1': 0,
  '2': 0,
  '3': 0,
  '4': 0,
  '5': 0,
});

function sortSpec(sort: RestaurantReviewSort): Record<string, 1 | -1> {
  if (sort === 'highest') return { rating: -1, createdAt: -1, _id: -1 };
  if (sort === 'lowest') return { rating: 1, createdAt: -1, _id: -1 };
  return { createdAt: -1, _id: -1 };
}

function roundRating(sum: number, count: number): number | null {
  if (count === 0) return null;
  return Math.round((sum * 10) / count) / 10;
}

function toAuthorDto(user: User): RestaurantReviewAuthorDto {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    isProfessional: user.isProfessional,
  };
}

@Injectable()
export class RestaurantReviewsService {
  constructor(
    @InjectModel(RestaurantReview.name)
    private readonly reviews: Model<RestaurantReview>,
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private readonly members: Model<WorkspaceMember>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    private readonly mongo: MongoService,
  ) {}

  async summariesByPageUserIds(
    pageUserIds: string[],
  ): Promise<Map<string, RestaurantRatingStats>> {
    if (pageUserIds.length === 0) return new Map();
    const rows = await this.reviews
      .aggregate<{ _id: string; count: number; sum: number }>([
        { $match: { pageUserId: { $in: pageUserIds } } },
        {
          $lookup: {
            from: this.users.collection.name,
            localField: 'authorId',
            foreignField: '_id',
            pipeline: [
              {
                $match: {
                  status: AccountStatus.ACTIVE,
                  emailVerifiedAt: { $ne: null },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: 'author',
          },
        },
        { $match: { 'author.0': { $exists: true } } },
        {
          $group: {
            _id: '$pageUserId',
            count: { $sum: 1 },
            sum: { $sum: '$rating' },
          },
        },
      ])
      .exec();

    const map = new Map<string, RestaurantRatingStats>();
    for (const row of rows) {
      map.set(row._id, {
        averageRating: roundRating(row.sum, row.count),
        reviewCount: row.count,
      });
    }
    return map;
  }

  async summaryForPage(
    pageUserId: string,
    session?: ClientSession,
  ): Promise<RestaurantReviewSummaryDto> {
    const pipeline = this.reviews.aggregate<{ _id: number; count: number }>([
      { $match: { pageUserId } },
      {
        $lookup: {
          from: this.users.collection.name,
          localField: 'authorId',
          foreignField: '_id',
          pipeline: [
            {
              $match: {
                status: AccountStatus.ACTIVE,
                emailVerifiedAt: { $ne: null },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'author',
        },
      },
      { $match: { 'author.0': { $exists: true } } },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);
    if (session) pipeline.session(session);
    const buckets = await pipeline.exec();

    const breakdown = emptyBreakdown();
    let reviewCount = 0;
    let sum = 0;
    for (const bucket of buckets) {
      const star = bucket._id;
      if (star < 1 || star > 5) continue;
      const key = String(star) as keyof RestaurantRatingBreakdownDto;
      breakdown[key] = bucket.count;
      reviewCount += bucket.count;
      sum += star * bucket.count;
    }
    return {
      averageRating: roundRating(sum, reviewCount),
      reviewCount,
      breakdown,
    };
  }

  async list(
    pageUserId: string,
    query: ListRestaurantReviewsQueryDto,
    viewerId?: string,
  ): Promise<RestaurantReviewPageDto> {
    await this.requireRestaurantPage(pageUserId);
    const { skip, take } = getPaginationArgs(query);

    const [summary, rows, myRow] = await Promise.all([
      this.summaryForPage(pageUserId),
      this.reviews
        .aggregate<{
          _id: string;
          rating: number;
          comment: string | null;
          createdAt: Date;
          updatedAt: Date;
          authorId: string;
        }>([
          { $match: { pageUserId } },
          {
            $lookup: {
              from: this.users.collection.name,
              localField: 'authorId',
              foreignField: '_id',
              pipeline: [
                {
                  $match: {
                    status: AccountStatus.ACTIVE,
                    emailVerifiedAt: { $ne: null },
                  },
                },
                { $project: { _id: 1 } },
              ],
              as: 'activeAuthor',
            },
          },
          { $match: { 'activeAuthor.0': { $exists: true } } },
          { $sort: sortSpec(query.sort) },
          { $skip: skip },
          { $limit: take },
          {
            $project: {
              _id: 1,
              rating: 1,
              comment: 1,
              createdAt: 1,
              updatedAt: 1,
              authorId: 1,
            },
          },
        ])
        .exec(),
      viewerId
        ? this.reviews.findOne({ pageUserId, authorId: viewerId }).exec()
        : Promise.resolve(null),
    ]);

    const authorIds = new Set<string>(rows.map((row) => row.authorId));
    if (myRow) authorIds.add(myRow.authorId);

    const authors = await this.users
      .find({
        _id: { $in: [...authorIds] },
        status: AccountStatus.ACTIVE,
        emailVerifiedAt: { $ne: null },
      })
      .exec();
    const authorById = new Map(authors.map((user) => [user.id, user]));

    const items: RestaurantReviewDto[] = [];
    for (const row of rows) {
      const author = authorById.get(row.authorId);
      if (!author) continue;
      items.push({
        id: row._id,
        rating: row.rating,
        comment: row.comment,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        author: toAuthorDto(author),
      });
    }

    let myReview: RestaurantReviewDto | null = null;
    if (myRow) {
      const author = authorById.get(myRow.authorId);
      if (author) {
        myReview = {
          id: myRow.id,
          rating: myRow.rating,
          comment: myRow.comment,
          createdAt: myRow.createdAt,
          updatedAt: myRow.updatedAt,
          author: toAuthorDto(author),
        };
      }
    }

    const paginated = createPaginatedResponse(items, summary.reviewCount, query);
    return {
      summary,
      myReview,
      items: paginated.items,
      meta: paginated.meta,
    };
  }

  async upsertMine(
    pageUserId: string,
    userId: string,
    dto: UpsertRestaurantReviewDto,
  ): Promise<RestaurantReviewMutationResponseDto> {
    return this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', userId);
      const actor = await this.users
        .findOne({ _id: userId })
        .session(session)
        .exec();
      if (!actor) {
        throw new UnauthenticatedException(
          'UNAUTHORIZED',
          'Account no longer exists',
        );
      }
      assertAccountActive(actor.status);
      if (!actor.emailVerifiedAt) {
        throw new AccessDeniedException(
          'EMAIL_NOT_VERIFIED',
          'Verify your email before reviewing a restaurant',
        );
      }

      const workspace = await this.requireRestaurantPage(pageUserId, session);
      await lockDocument(this.mongo, session, 'workspace', workspace.id);

      const isMember = await this.members
        .exists({ workspaceId: workspace.id, userId })
        .session(session)
        .exec();
      if (isMember) {
        throw new AccessDeniedException(
          'SELF_RATING_NOT_ALLOWED',
          'You cannot review your own restaurant',
        );
      }

      const now = new Date();
      await this.reviews
        .updateOne(
          { pageUserId, authorId: userId },
          {
            $set: {
              workspaceId: workspace.id,
              rating: dto.rating,
              comment: dto.comment ?? null,
              updatedAt: now,
            },
            $setOnInsert: {
              _id: randomUUID(),
              createdAt: now,
            },
          },
          { upsert: true, session },
        )
        .exec()
        .catch((error: unknown) =>
          rethrowAsStateConflict(
            error,
            'RATING_CONFLICT',
            'The review changed; reload and try again',
          ),
        );

      const saved = await this.reviews
        .findOne({ pageUserId, authorId: userId })
        .session(session)
        .exec();
      if (!saved) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Review not found');
      }

      const summary = await this.summaryForPage(pageUserId, session);
      return {
        review: {
          id: saved.id,
          rating: saved.rating,
          comment: saved.comment,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
          author: toAuthorDto(actor),
        },
        summary,
      };
    });
  }

  async deleteMine(
    pageUserId: string,
    userId: string,
  ): Promise<RestaurantReviewSummaryDto> {
    await this.requireRestaurantPage(pageUserId);
    await this.reviews.deleteOne({ pageUserId, authorId: userId }).exec();
    return this.summaryForPage(pageUserId);
  }

  private async requireRestaurantPage(
    pageUserId: string,
    session?: ClientSession,
  ): Promise<Workspace> {
    const workspaceQuery = this.workspaces.findOne({
      pageUserId,
      status: VerificationStatus.APPROVED,
    });
    if (session) workspaceQuery.session(session);
    const workspace = await workspaceQuery.exec();

    const userQuery = this.users
      .findOne({
        _id: pageUserId,
        status: AccountStatus.ACTIVE,
        emailVerifiedAt: { $ne: null },
      })
      .select('_id');
    if (session) userQuery.session(session);
    const pageUser = await userQuery.exec();

    if (!workspace || !pageUser) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Restaurant not found');
    }
    return workspace;
  }
}
