import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProfileImageKind, ProfileImageStatus } from '@prisma/client';
import { del } from '@vercel/blob';
import {
  generateClientTokenFromReadWriteToken,
  handleUpload,
} from '@vercel/blob/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { ProfilesService } from './profiles.service';

vi.mock('@vercel/blob/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob/client')>()),
  generateClientTokenFromReadWriteToken: vi.fn(),
  handleUpload: vi.fn(),
}));
vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  del: vi.fn(),
}));

const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const viewerId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const user = {
  id: userId,
  username: 'vedora.user',
  fullName: 'Vedora User',
  emailVerifiedAt: new Date(),
  bio: 'Plant based cooking',
  avatarUrl: null,
  coverUrl: null,
  createdAt: new Date('2026-09-28T08:00:00Z'),
};
const imageId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
const pathname = `profiles/${userId}/avatar/${imageId}.webp`;
const callbackUrl = 'https://api.vedora.vn/api/v1/webhooks/vercel-blob';

describe('ProfilesService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: ProfilesService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = mockDeep<PrismaService>();
    service = new ProfilesService(
      prisma,
      new ConfigService({
        BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_public_secret',
        BLOB_CALLBACK_URL: callbackUrl,
      }),
    );
    prisma.user.findUnique.mockResolvedValue(user as never);
    prisma.post.count.mockResolvedValue(3);
    prisma.follow.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
  });

  it('returns public fields and published-post/follow counts', async () => {
    const profile = await service.findOne(userId);
    expect(profile).toMatchObject({
      id: userId,
      postCount: 3,
      followerCount: 5,
      followingCount: 2,
    });
    expect(profile).not.toHaveProperty('email');
    expect(prisma.post.count).toHaveBeenCalledWith({
      where: { authorId: userId, status: 'PUBLISHED' },
    });
  });

  it('does not expose unverified accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      emailVerifiedAt: null,
    } as never);
    await expect(service.findOne(userId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.follow.count).not.toHaveBeenCalled();
  });

  it('rejects self-follow and writes other follows idempotently', async () => {
    await expect(service.follow(userId, userId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await service.follow(userId, viewerId);
    expect(prisma.follow.createMany).toHaveBeenCalledWith({
      data: [{ followerId: viewerId, followingId: userId }],
      skipDuplicates: true,
    });
    await service.unfollow(userId, viewerId);
    expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
      where: { followerId: viewerId, followingId: userId },
    });
  });

  it('paginates followers by the last returned user ID', async () => {
    prisma.follow.findMany.mockResolvedValue([
      { follower: { ...user, id: viewerId } },
      { follower: user },
    ] as never);
    const result = await service.followers(userId, { limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(viewerId);
    expect(prisma.follow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { followerId: 'desc' }],
      }),
    );
  });

  it('issues a public-image token scoped to the owner, type and callback', async () => {
    vi.mocked(generateClientTokenFromReadWriteToken).mockResolvedValue(
      'client-token',
    );
    const result = await service.createImageUpload(userId, {
      kind: ProfileImageKind.AVATAR,
      contentType: 'image/webp',
      sizeBytes: 1000,
    });
    expect(result.pathname).toMatch(
      new RegExp(`^profiles/${userId}/avatar/[0-9a-f-]{36}\\.webp$`),
    );
    expect(generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: result.pathname,
        allowedContentTypes: ['image/webp'],
        maximumSizeInBytes: 5 * 1024 * 1024,
        onUploadCompleted: { callbackUrl, tokenPayload: result.id },
      }),
    );
    expect(
      prisma.profileImageUpload.create.mock.calls[0][0].data,
    ).toMatchObject({
      ownerId: userId,
      pathname: result.pathname,
    });
  });

  it('only activates a confirmed upload owned by the caller', async () => {
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce(null);
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce({
      id: imageId,
      ownerId: userId,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.WAITING_UPLOAD,
      pathname,
      url: null,
      createdAt: new Date(),
    } as never);
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce({
      id: imageId,
      ownerId: userId,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.READY,
      pathname,
      url: 'https://public.blob.vercel-storage.com/avatar.webp',
      createdAt: new Date(),
    } as never);
    await service.activateImage(userId, imageId);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        avatarPathname: pathname,
        avatarUrl: 'https://public.blob.vercel-storage.com/avatar.webp',
      },
    });
  });

  it('accepts only a signed upload-completed callback for the expected path and content type', async () => {
    prisma.profileImageUpload.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(handleUpload).mockImplementation(async (options) => {
      await options.onUploadCompleted?.({
        blob: {
          pathname,
          contentType: 'image/webp',
          url: 'https://public.blob.vercel-storage.com/avatar.webp',
        },
      } as never);
      return { type: 'blob.upload-completed', response: 'ok' };
    });
    await service.handleImageCallback(
      { type: 'blob.upload-completed' } as never,
      {} as never,
    );
    expect(prisma.profileImageUpload.updateMany).toHaveBeenCalledWith({
      where: {
        pathname,
        contentType: 'image/webp',
        status: ProfileImageStatus.WAITING_UPLOAD,
      },
      data: {
        status: ProfileImageStatus.READY,
        url: 'https://public.blob.vercel-storage.com/avatar.webp',
      },
    });
  });

  it('keeps active images and purges old unused uploads', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    prisma.profileImageUpload.findMany.mockResolvedValue([
      { id: imageId, pathname, createdAt: old },
      { id: viewerId, pathname: 'profiles/unused.webp', createdAt: old },
    ] as never);
    prisma.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await service.purgeUnusedImages();
    expect(del).toHaveBeenCalledWith('profiles/unused.webp', {
      token: 'vercel_blob_rw_public_secret',
    });
    expect(del).not.toHaveBeenCalledWith(pathname, expect.anything());
    expect(prisma.profileImageUpload.delete).toHaveBeenCalledWith({
      where: { id: viewerId },
    });
  });
});
