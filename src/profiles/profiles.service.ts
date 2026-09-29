import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PostStatus,
  Prisma,
  ProfileImageKind,
  ProfileImageStatus,
} from '@prisma/client';
import { BlobNotFoundError, del } from '@vercel/blob';
import {
  generateClientTokenFromReadWriteToken,
  handleUpload,
  type HandleUploadBody,
} from '@vercel/blob/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CursorPaginationQueryDto } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
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
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const ACTIVATE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_AGE_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);
  private readonly blobToken: string;
  private readonly callbackUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.blobToken = config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    this.callbackUrl = config.get<string>('BLOB_CALLBACK_URL', '');
  }

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
    const token = this.requireBlob();
    const callbackUrl = this.requireCallback();
    const maximumSizeInBytes =
      dto.kind === ProfileImageKind.AVATAR ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (dto.sizeBytes > maximumSizeInBytes)
      throw new PayloadTooLargeException('Profile image is too large');
    const extension = IMAGE_EXTENSIONS[dto.contentType];
    if (!extension) throw new BadRequestException('Unsupported image type');
    const id = randomUUID();
    const pathname = `profiles/${ownerId}/${dto.kind.toLowerCase()}/${id}.${extension}`;
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      allowedContentTypes: [dto.contentType],
      maximumSizeInBytes,
      validUntil: Date.now() + UPLOAD_TTL_MS,
      onUploadCompleted: { callbackUrl, tokenPayload: id },
    });
    await this.prisma.profileImageUpload.create({
      data: {
        id,
        ownerId,
        kind: dto.kind,
        contentType: dto.contentType,
        pathname,
      },
    });
    return { id, pathname, clientToken };
  }

  async handleImageCallback(
    body: HandleUploadBody,
    request: IncomingMessage,
  ): Promise<void> {
    if (body?.type !== 'blob.upload-completed')
      throw new BadRequestException('Expected an upload-completed callback');
    await handleUpload({
      token: this.requireBlob(),
      body,
      request,
      onBeforeGenerateToken: () =>
        Promise.reject(
          new Error('Upload tokens are issued by the profile API'),
        ),
      onUploadCompleted: async ({ blob }) => {
        const result = await this.prisma.profileImageUpload.updateMany({
          where: {
            pathname: blob.pathname,
            contentType: blob.contentType,
            status: ProfileImageStatus.WAITING_UPLOAD,
          },
          data: { status: ProfileImageStatus.READY, url: blob.url },
        });
        if (result.count === 0)
          this.logger.warn(
            `Unmatched profile image callback: ${blob.pathname}`,
          );
      },
    });
  }

  async activateImage(ownerId: string, uploadId: string): Promise<ProfileDto> {
    const image = await this.prisma.profileImageUpload.findFirst({
      where: { id: uploadId, ownerId },
    });
    if (!image) throw new NotFoundException('Image upload not found');
    if (image.status !== ProfileImageStatus.READY || !image.url)
      throw new ConflictException('Image upload is not ready');
    if (image.createdAt.getTime() < Date.now() - ACTIVATE_TTL_MS)
      throw new ConflictException('Image upload has expired');
    const data =
      image.kind === ProfileImageKind.AVATAR
        ? { avatarUrl: image.url, avatarPathname: image.pathname }
        : { coverUrl: image.url, coverPathname: image.pathname };
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
          ? { avatarUrl: null, avatarPathname: null }
          : { coverUrl: null, coverPathname: null },
    });
    return this.findOne(ownerId);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeUnusedImages(): Promise<void> {
    if (!this.blobToken) return;
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
        const inUse = await this.prisma.user.count({
          where: {
            OR: [
              { avatarPathname: image.pathname },
              { coverPathname: image.pathname },
            ],
          },
        });
        if (inUse) continue;
        try {
          await del(image.pathname, { token: this.blobToken });
        } catch (error) {
          if (!(error instanceof BlobNotFoundError)) {
            this.logger.warn(
              `Could not purge ${image.pathname}: ${String(error)}`,
            );
            continue;
          }
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

  private requireBlob(): string {
    if (!this.blobToken)
      throw new ServiceUnavailableException(
        'Profile image storage is not configured',
      );
    return this.blobToken;
  }

  private requireCallback(): string {
    if (!this.callbackUrl)
      throw new ServiceUnavailableException(
        'Profile image callback is not configured',
      );
    return this.callbackUrl;
  }
}
