import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { afterCursor, CursorPaginationQueryDto } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { isUniqueViolation } from '../mongo/errors';
import {
  Follow,
  NotificationType,
  Post,
  PostStatus,
  ProfileImageKind,
  ProfileImageStatus,
  ProfileImageUpload,
  User,
} from '../mongo/models';
import { StorageService, StorageTarget } from '../storage/storage.service';
import {
  CreateProfileImageUploadDto,
  ProfileDto,
  ProfileImageUploadDto,
  ProfileListDto,
  ProfileRelationshipDto,
  ProfileSummaryDto,
  UpdateProfileDto,
} from './dto/profile.dto';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES: Record<ProfileImageKind, number> = {
  AVATAR: 5 * 1024 * 1024,
  COVER: 10 * 1024 * 1024,
};
const ACTIVATE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_AGE_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
    @InjectModel(ProfileImageUpload.name)
    private readonly uploads: Model<ProfileImageUpload>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  async findOne(id: string): Promise<ProfileDto> {
    const user = await this.requirePublicUser(id);
    const [postCount, followerCount, followingCount] = await Promise.all([
      this.posts.countDocuments({
        authorId: id,
        status: PostStatus.PUBLISHED,
      }),
      this.follows.countDocuments({ followingId: id }),
      this.follows.countDocuments({ followerId: id }),
    ]);
    return {
      ...this.summary(user),
      createdAt: user.createdAt,
      postCount,
      followerCount,
      followingCount,
    };
  }

  async updateMe(id: string, dto: UpdateProfileDto): Promise<ProfileDto> {
    const fullName = dto.fullName?.trim();
    if (fullName === '') throw new BadRequestException('Full name is required');
    await this.users.updateOne(
      { _id: id },
      {
        $set: {
          ...(fullName !== undefined && { fullName }),
          ...(dto.bio !== undefined && { bio: dto.bio.trim() || null }),
        },
      },
    );
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
      throw new BadRequestException('You cannot follow yourself');
    await this.requirePublicUser(id);
    let created = true;
    try {
      await this.follows.create({ followerId, followingId: id });
    } catch (error) {
      // Already following: a repeat request is not an error.
      if (!isUniqueViolation(error)) throw error;
      created = false;
    }
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
    await this.follows.deleteOne({ followerId, followingId: id });
  }

  async followers(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    // The cursor is the follower's id; the follow gives its place.
    return this.followList({ followingId: id }, 'followerId', query);
  }

  async following(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    // The cursor is the followed account's id; the follow gives its place.
    return this.followList({ followerId: id }, 'followingId', query);
  }

  /** One page of follows, joined to the accounts on `accountField`. */
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
    const rows = await this.follows
      .find(match)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const accounts = await this.users
      .find({ _id: { $in: rows.map((row) => row[accountField]) } })
      .exec();
    const byId = new Map(accounts.map((user) => [user.id, user]));
    // MongoDB has no relation filters: unverified accounts drop out here.
    const items: ProfileSummaryDto[] = [];
    for (const row of rows) {
      const user = byId.get(row[accountField]);
      if (user?.emailVerifiedAt) items.push(this.summary(user));
    }
    return this.listResult(items, query.limit);
  }

  async createImageUpload(
    ownerId: string,
    dto: CreateProfileImageUploadDto,
  ): Promise<ProfileImageUploadDto> {
    if (dto.sizeBytes > MAX_IMAGE_BYTES[dto.kind])
      throw new PayloadTooLargeException('Profile image is too large');
    const extension = IMAGE_EXTENSIONS[dto.contentType];
    if (!extension) throw new BadRequestException('Unsupported image type');
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

  async markImageUploaded(key: string): Promise<void> {
    const updated = await this.uploads.updateOne(
      { storageKey: key, status: ProfileImageStatus.WAITING_UPLOAD },
      { $set: { status: ProfileImageStatus.READY } },
    );
    if (updated.matchedCount === 0)
      this.logger.warn(`No waiting profile image for ${key}`);
  }

  async activateImage(ownerId: string, uploadId: string): Promise<ProfileDto> {
    const image = await this.uploads.findOne({ _id: uploadId, ownerId }).exec();
    if (!image) throw new NotFoundException('Image upload not found');
    if (image.status !== ProfileImageStatus.READY)
      throw new ConflictException('Image upload is not ready');
    if (image.createdAt.getTime() < Date.now() - ACTIVATE_TTL_MS)
      throw new ConflictException('Image upload has expired');
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

  @Cron(CronExpression.EVERY_HOUR)
  async purgeUnusedImages(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);
    let after: { id: string; createdAt: Date } | undefined;
    // Keyset paging keeps active images from blocking cleanup of later rows.
    for (;;) {
      const filter: QueryFilter<ProfileImageUpload> = {
        createdAt: { $lt: cutoff },
      };
      if (after) {
        // Ascending keyset: the rows after the last one handled.
        filter.$or = [
          { createdAt: { $gt: after.createdAt } },
          { createdAt: after.createdAt, _id: { $gt: after.id } },
        ];
      }
      const images = await this.uploads
        .find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .limit(100)
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
      if (images.length < 100) break;
      after = { id: images[99].id, createdAt: images[99].createdAt };
    }
  }

  private async requirePublicUser(id: string): Promise<User> {
    const user = await this.users.findOne({ _id: id }).exec();
    if (!user?.emailVerifiedAt)
      throw new NotFoundException('Profile not found');
    return user;
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
