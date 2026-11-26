import { runtimeConfig } from '../config/runtime-config.js';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import {
  afterCursor,
  CursorPaginationQueryDto,
} from '../common/pagination/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { assertAccountActive } from '../auth-core/account-access.js';
import { MongoService } from '../mongo/mongo.service.js';
import { withUserLocks } from '../mongo/with-user-locks.js';
import { MessagingEventsService } from '../messaging/messaging-events.service.js';
import {
  AccountStatus,
  Follow,
  MessagingEventType,
  NotificationType,
  Post,
  PostStatus,
  ProfileImageKind,
  ProfileImageStatus,
  ProfileImageUpload,
  RestaurantMenuItem,
  RestaurantReview,
  User,
  VerificationStatus,
  Workspace,
} from '../mongo/models.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  CreateProfileImageUploadDto,
  ProfileDto,
  ProfileImageUploadDto,
  ProfileListDto,
  ProfileRelationshipDto,
  ProfileSearchItemDto,
  ProfileSearchPageDto,
  ProfileSummaryDto,
  RestaurantProfileDto,
  UpdateProfileDto,
} from './dto/profile.dto.js';
import { SearchProfilesQueryDto } from './dto/search-profiles-query.dto.js';
import { ProfileSearchIndexService } from './search/profile-search-index.service.js';
import {
  MAX_PROFILE_SEARCH_RESULTS,
  ProfileSearchService,
} from './search/profile-search.service.js';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { presentString } from '../mongo/partial-match.js';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES: Record<ProfileImageKind, number> = {
  AVATAR: runtimeConfig.PROFILE_AVATAR_MAX_MB * 1024 * 1024,
  COVER: runtimeConfig.PROFILE_COVER_MAX_MB * 1024 * 1024,
};
const ACTIVATE_TTL_MS =
  runtimeConfig.PROFILE_IMAGE_ACTIVATION_TTL_SECONDS * 1000;
const CLEANUP_AGE_MS = runtimeConfig.PROFILE_IMAGE_CLEANUP_AGE_SECONDS * 1000;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
    @InjectModel(ProfileImageUpload.name)
    private readonly uploads: Model<ProfileImageUpload>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly mongo: MongoService,
    @Optional() private readonly messagingEvents?: MessagingEventsService,
    @Optional() private readonly profileSearch?: ProfileSearchService,
    @Optional() private readonly profileSearchIndex?: ProfileSearchIndexService,
    @Optional()
    @InjectModel(RestaurantReview.name)
    private readonly restaurantReviews?: Model<RestaurantReview>,
    @Optional()
    @InjectModel(RestaurantMenuItem.name)
    private readonly menuItems?: Model<RestaurantMenuItem>,
  ) {}

  async search(
    query: SearchProfilesQueryDto,
    viewerId?: string,
  ): Promise<ProfileSearchPageDto> {
    const offset = query.cursor ?? 0;
    const limit = Math.min(query.limit, MAX_PROFILE_SEARCH_RESULTS - offset);
    if (limit <= 0 || !this.profileSearch) {
      return { items: [], nextCursor: null };
    }

    const { ids, hasMore } = await this.profileSearch.search(
      query.q,
      offset,
      limit,
    );
    if (ids.length === 0) return { items: [], nextCursor: null };

    const users = await this.users.find({ _id: { $in: ids } }).exec();
    const active = new Map(
      users
        .filter(
          (user) =>
            Boolean(user.emailVerifiedAt) &&
            user.status === AccountStatus.ACTIVE,
        )
        .map((user) => [user.id, user]),
    );
    const stale = ids.filter((id) => !active.has(id));
    if (stale.length > 0) {
      void this.profileSearch.prune(stale).catch(() => undefined);
    }

    const activeIds = [...active.keys()];
    const followingIds =
      viewerId && activeIds.length > 0
        ? new Set(
            (
              await this.follows
                .find({
                  followerId: viewerId,
                  followingId: { $in: activeIds },
                })
                .select('followingId')
                .exec()
            ).map(({ followingId }) => followingId),
          )
        : new Set<string>();

    const items: ProfileSearchItemDto[] = [];
    for (const id of ids) {
      const user = active.get(id);
      if (!user) continue;
      items.push({
        ...this.summary(user),
        isFollowing: Boolean(
          viewerId && id !== viewerId && followingIds.has(id),
        ),
      });
    }

    return {
      items,
      nextCursor:
        hasMore && offset + limit < MAX_PROFILE_SEARCH_RESULTS
          ? String(offset + limit)
          : null,
    };
  }

  async findOne(id: string): Promise<ProfileDto> {
    const user = await this.requirePublicUser(id);
    const [postCount, followerCount, followingCount, restaurant] =
      await Promise.all([
        this.posts.countDocuments({
          authorId: id,
          status: PostStatus.PUBLISHED,
        }),
        this.follows.countDocuments({ followingId: id }),
        this.follows.countDocuments({ followerId: id }),
        this.restaurantOf(id),
      ]);
    return {
      ...this.summary(user),
      accountType: user.accountType,
      restaurant,
      createdAt: user.createdAt,
      postCount,
      followerCount,
      followingCount,
    };
  }

  async updateMe(id: string, dto: UpdateProfileDto): Promise<ProfileDto> {
    const fullName = dto.fullName?.trim();
    if (fullName === '')
      throw new InvalidInputException('BAD_REQUEST', 'Full name is required');
    await this.users.updateOne(
      { _id: id },
      {
        $set: {
          ...(fullName !== undefined && { fullName }),
          ...(dto.bio !== undefined && { bio: dto.bio.trim() || null }),
          searchIndexedAt: null,
        },
      },
    );
    if (fullName !== undefined && this.menuItems) {
      await this.menuItems
        .updateMany({ pageUserId: id }, { $set: { searchIndexedAt: null } })
        .exec();
    }
    this.profileSearchIndex?.schedule();
    return this.findOne(id);
  }

  async relationship(
    id: string,
    viewerId: string,
  ): Promise<ProfileRelationshipDto> {
    await this.requirePublicUser(id);
    if (id === viewerId) return { isFollowing: false };
    return {
      isFollowing: !!(await this.follows
        .findOne({ followerId: viewerId, followingId: id })
        .exec()),
    };
  }

  async follow(id: string, followerId: string): Promise<void> {
    if (id === followerId)
      throw new InvalidInputException(
        'BAD_REQUEST',
        'You cannot follow yourself',
      );
    await this.requirePublicUser(id);
    const created = await withUserLocks(
      this.mongo,
      [id, followerId],
      async (session) => {
        const actor = await this.users
          .findById(followerId)
          .session(session)
          .exec();
        if (
          !actor ||
          !(await this.users
            .exists({ _id: id, emailVerifiedAt: { $ne: null } })
            .session(session))
        ) {
          throw new ResourceNotFoundException('NOT_FOUND', 'Profile not found');
        }
        assertAccountActive(actor.status);
        const result = await this.follows.updateOne(
          { followerId, followingId: id },
          { $setOnInsert: { followerId, followingId: id } },
          { upsert: true, session },
        );
        if (result.upsertedCount > 0) {
          await this.messagingEvents?.record(
            [id, followerId],
            { type: MessagingEventType.RELATIONSHIP_CHANGED },
            session,
          );
        }
        return result.upsertedCount > 0;
      },
    );
    if (created) {
      await this.notifications.notify({
        recipientId: id,
        actorId: followerId,
        type: NotificationType.FOLLOW,
      });
    }
  }

  async unfollow(id: string, followerId: string): Promise<void> {
    await this.requirePublicUser(id);
    await withUserLocks(this.mongo, [id, followerId], async (session) => {
      const result = await this.follows.deleteOne(
        { followerId, followingId: id },
        { session },
      );
      if (result.deletedCount > 0) {
        await this.messagingEvents?.record(
          [id, followerId],
          { type: MessagingEventType.RELATIONSHIP_CHANGED },
          session,
        );
      }
    });
  }

  async followers(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    return this.followList({ followingId: id }, 'followerId', query);
  }

  async following(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    return this.followList({ followerId: id }, 'followingId', query);
  }

  private async followList(
    filter: QueryFilter<Follow>,
    accountField: 'followerId' | 'followingId',
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    let match = filter;
    if (query.cursor) {
      const cursor = await this.follows
        .findOne({ ...filter, [accountField]: query.cursor })
        .exec();
      if (!cursor) return { items: [], nextCursor: null };
      match = {
        $and: [
          filter,
          afterCursor('createdAt', { value: cursor.createdAt, id: cursor.id }),
        ],
      };
    }
    // Unverified accounts are skipped before the limit, not after, so one in
    // the lookahead row cannot end the list early.
    const rows = await this.follows
      .aggregate<{ accountId: string }>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $lookup: {
            from: this.users.collection.name,
            localField: accountField,
            foreignField: '_id',
            pipeline: [
              { $match: { emailVerifiedAt: { $ne: null } } },
              { $project: { _id: 1 } },
            ],
            as: 'verified',
          },
        },
        { $match: { 'verified.0': { $exists: true } } },
        { $limit: query.limit + 1 },
        { $project: { _id: 0, accountId: `$${accountField}` } },
      ])
      .exec();
    const accounts = await this.users
      .find({ _id: { $in: rows.map((row) => row.accountId) } })
      .exec();
    const byId = new Map(accounts.map((user) => [user.id, user]));
    const items: ProfileSummaryDto[] = [];
    for (const row of rows) {
      const user = byId.get(row.accountId);
      if (user) items.push(this.summary(user));
    }
    return this.listResult(items, query.limit);
  }

  async createImageUpload(
    ownerId: string,
    dto: CreateProfileImageUploadDto,
  ): Promise<ProfileImageUploadDto> {
    if (dto.sizeBytes > MAX_IMAGE_BYTES[dto.kind])
      throw new FileTooLargeException(
        'FILE_TOO_LARGE',
        'Profile image is too large',
      );
    const extension = IMAGE_EXTENSIONS[dto.contentType];
    if (!extension)
      throw new InvalidInputException('BAD_REQUEST', 'Unsupported image type');
    const id = randomUUID();
    const key = `profiles/${ownerId}/${dto.kind.toLowerCase()}/${id}.${extension}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Profiles,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    await this.uploads.create({
      _id: id,
      ownerId,
      kind: dto.kind,
      status: ProfileImageStatus.WAITING_UPLOAD,
      storageKey: key,
    });
    return { id, upload };
  }

  async activateImage(ownerId: string, uploadId: string): Promise<ProfileDto> {
    const image = await this.uploads.findOne({ _id: uploadId, ownerId }).exec();
    if (!image)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Image upload not found',
      );
    if (image.createdAt.getTime() < Date.now() - ACTIVATE_TTL_MS)
      throw new StateConflictException('CONFLICT', 'Image upload has expired');
    if (image.status === ProfileImageStatus.WAITING_UPLOAD) {
      const uploaded = await this.storage.exists(
        StorageTarget.Profiles,
        image.storageKey,
      );
      if (!uploaded)
        throw new StateConflictException(
          'CONFLICT',
          'Image upload is not ready',
        );
      await this.uploads.updateOne(
        { _id: uploadId, status: ProfileImageStatus.WAITING_UPLOAD },
        { $set: { status: ProfileImageStatus.READY } },
      );
    } else if (image.status !== ProfileImageStatus.READY) {
      throw new StateConflictException('CONFLICT', 'Image upload is not ready');
    }
    const url = this.storage.publicObjectUrl(
      StorageTarget.Profiles,
      image.storageKey,
    );
    const data =
      image.kind === ProfileImageKind.AVATAR
        ? { avatarUrl: url }
        : { coverUrl: url };
    await this.users.updateOne({ _id: ownerId }, { $set: data });
    return this.findOne(ownerId);
  }

  async clearImage(
    ownerId: string,
    kind: ProfileImageKind,
  ): Promise<ProfileDto> {
    await this.users.updateOne(
      { _id: ownerId },
      {
        $set:
          kind === ProfileImageKind.AVATAR
            ? { avatarUrl: null }
            : { coverUrl: null },
      },
    );
    return this.findOne(ownerId);
  }

  @Cron(runtimeConfig.PROFILE_IMAGE_CLEANUP_CRON)
  async purgeUnusedImages(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);
    let after: { id: string; createdAt: Date } | undefined;
    for (;;) {
      const filter: QueryFilter<ProfileImageUpload> = {
        createdAt: { $lt: cutoff },
      };
      if (after) {
        filter.$or = [
          { createdAt: { $gt: after.createdAt } },
          { createdAt: after.createdAt, _id: { $gt: after.id } },
        ];
      }
      const images = await this.uploads
        .find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .limit(runtimeConfig.PROFILE_IMAGE_CLEANUP_BATCH_SIZE)
        .exec();
      for (const image of images) {
        const url = this.storage.publicObjectUrl(
          StorageTarget.Profiles,
          image.storageKey,
        );
        const inUse = await this.users.countDocuments({
          $or: [{ avatarUrl: url }, { coverUrl: url }],
        });
        if (inUse) continue;
        try {
          await this.storage.delete(StorageTarget.Profiles, image.storageKey);
        } catch (error) {
          this.logger.warn(
            `Could not purge ${image.storageKey}: ${String(error)}`,
          );
          continue;
        }
        await this.uploads.deleteOne({ _id: image.id });
      }
      if (images.length < runtimeConfig.PROFILE_IMAGE_CLEANUP_BATCH_SIZE) break;
      const last = images[images.length - 1];
      after = { id: last.id, createdAt: last.createdAt };
    }
  }

  private async requirePublicUser(id: string): Promise<User> {
    const user = await this.users.findOne({ _id: id }).exec();
    // The Vedora AI system account has no public profile.
    if (!user?.emailVerifiedAt || user.status === AccountStatus.SYSTEM)
      throw new ResourceNotFoundException('NOT_FOUND', 'Profile not found');
    return user;
  }

  private async restaurantOf(
    pageUserId: string,
  ): Promise<RestaurantProfileDto | null> {
    const workspace = await this.workspaces
      .findOne({
        pageUserId: presentString(pageUserId),
        status: VerificationStatus.APPROVED,
      })
      .exec();
    if (!workspace) return null;
    const [longitude, latitude] = workspace.location.coordinates;
    const [stats] = this.restaurantReviews
      ? await this.restaurantReviews
          .aggregate<{ count: number; sum: number }>([
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
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                sum: { $sum: '$rating' },
              },
            },
          ])
          .exec()
      : [];
    const reviewCount = stats?.count ?? 0;
    const averageRating =
      reviewCount === 0
        ? null
        : Math.round((stats.sum * 10) / reviewCount) / 10;
    return {
      workspaceId: workspace.id,
      address: workspace.address,
      longitude,
      latitude,
      phone: workspace.phone,
      website: workspace.website,
      averageRating,
      reviewCount,
    };
  }

  private summary(user: User): ProfileSummaryDto {
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      coverUrl: user.coverUrl,
      isProfessional: user.isProfessional,
    };
  }

  private listResult(rows: ProfileSummaryDto[], limit: number): ProfileListDto {
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }
}
