import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  PostStatus,
  Prisma,
  ProfileImageKind,
  ProfileImageStatus,
} from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CursorPaginationQueryDto } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
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

const profileSelect = {
  id: true,
  username: true,
  fullName: true,
  bio: true,
  avatarUrl: true,
  coverUrl: true,
  createdAt: true,
  emailVerifiedAt: true,
} satisfies Prisma.UserSelect;
type ProfileUser = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

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
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findOne(id: string): Promise<ProfileDto> {
    const user = await this.requirePublicUser(id);
    const [postCount, followerCount, followingCount] = await Promise.all([
      this.prisma.post.count({
        where: { authorId: id, status: PostStatus.PUBLISHED },
      }),
      this.prisma.follow.count({ where: { followingId: id } }),
      this.prisma.follow.count({ where: { followerId: id } }),
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
    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.bio !== undefined) data.bio = dto.bio.trim() || null;
    if (data.fullName === '')
      throw new BadRequestException('Full name is required');
    await this.prisma.user.update({ where: { id }, data });
    return this.findOne(id);
  }

  async relationship(
    id: string,
    viewerId: string,
  ): Promise<ProfileRelationshipDto> {
    await this.requirePublicUser(id);
    if (id === viewerId) return { isFollowing: false };
    return {
      isFollowing: !!(await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: { followerId: viewerId, followingId: id },
        },
      })),
    };
  }

  async follow(id: string, followerId: string): Promise<void> {
    if (id === followerId)
      throw new BadRequestException('You cannot follow yourself');
    await this.requirePublicUser(id);
    await this.prisma.follow.createMany({
      data: [{ followerId, followingId: id }],
      skipDuplicates: true,
    });
  }

  async unfollow(id: string, followerId: string): Promise<void> {
    await this.requirePublicUser(id);
    await this.prisma.follow.deleteMany({
      where: { followerId, followingId: id },
    });
  }

  async followers(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    const rows = await this.prisma.follow.findMany({
      where: { followingId: id, follower: { emailVerifiedAt: { not: null } } },
      orderBy: [{ createdAt: 'desc' }, { followerId: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor
        ? {
            cursor: {
              followerId_followingId: {
                followerId: query.cursor,
                followingId: id,
              },
            },
            skip: 1,
          }
        : {}),
      include: { follower: { select: profileSelect } },
    });
    return this.listResult(
      rows.map((row) => this.summary(row.follower)),
      query.limit,
    );
  }

  async following(
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    await this.requirePublicUser(id);
    const rows = await this.prisma.follow.findMany({
      where: { followerId: id, following: { emailVerifiedAt: { not: null } } },
      orderBy: [{ createdAt: 'desc' }, { followingId: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor
        ? {
            cursor: {
              followerId_followingId: {
                followerId: id,
                followingId: query.cursor,
              },
            },
            skip: 1,
          }
        : {}),
      include: { following: { select: profileSelect } },
    });
    return this.listResult(
      rows.map((row) => this.summary(row.following)),
      query.limit,
    );
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
    await this.prisma.profileImageUpload.create({
      data: {
        id,
        ownerId,
        kind: dto.kind,
        storageKey: key,
      },
    });
    return { id, upload };
  }

  async markImageUploaded(key: string): Promise<void> {
    const result = await this.prisma.profileImageUpload.updateMany({
      where: {
        storageKey: key,
        status: ProfileImageStatus.WAITING_UPLOAD,
      },
      data: { status: ProfileImageStatus.READY },
    });
    if (result.count === 0)
      this.logger.warn(`No waiting profile image for ${key}`);
  }

  async activateImage(ownerId: string, uploadId: string): Promise<ProfileDto> {
    const image = await this.prisma.profileImageUpload.findFirst({
      where: { id: uploadId, ownerId },
    });
    if (!image) throw new NotFoundException('Image upload not found');
    if (image.status !== ProfileImageStatus.READY)
      throw new ConflictException('Image upload is not ready');
    if (image.createdAt.getTime() < Date.now() - ACTIVATE_TTL_MS)
      throw new ConflictException('Image upload has expired');
    const url = this.storage.publicObjectUrl(image.storageKey);
    const data =
      image.kind === ProfileImageKind.AVATAR
        ? { avatarUrl: url }
        : { coverUrl: url };
    await this.prisma.user.update({ where: { id: ownerId }, data });
    return this.findOne(ownerId);
  }

  async clearImage(
    ownerId: string,
    kind: ProfileImageKind,
  ): Promise<ProfileDto> {
    await this.prisma.user.update({
      where: { id: ownerId },
      data:
        kind === ProfileImageKind.AVATAR
          ? { avatarUrl: null }
          : { coverUrl: null },
    });
    return this.findOne(ownerId);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeUnusedImages(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);
    let after: { id: string; createdAt: Date } | undefined;
    // Keyset paging keeps active images from blocking cleanup of later rows.
    for (;;) {
      const images = await this.prisma.profileImageUpload.findMany({
        where: {
          createdAt: { lt: cutoff },
          ...(after
            ? {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      for (const image of images) {
        const url = this.storage.publicObjectUrl(image.storageKey);
        const inUse = await this.prisma.user.count({
          where: { OR: [{ avatarUrl: url }, { coverUrl: url }] },
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
        await this.prisma.profileImageUpload.delete({
          where: { id: image.id },
        });
      }
      if (images.length < 100) break;
      after = { id: images[99].id, createdAt: images[99].createdAt };
    }
  }

  private async requirePublicUser(id: string): Promise<ProfileUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: profileSelect,
    });
    if (!user?.emailVerifiedAt)
      throw new NotFoundException('Profile not found');
    return user;
  }

  private summary(user: ProfileUser): ProfileSummaryDto {
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      coverUrl: user.coverUrl,
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
