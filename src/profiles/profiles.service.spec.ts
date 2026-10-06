import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  ProfileImageKind,
  ProfileImageStatus,
  type ProfileImageUpload,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import type { PresignedUploadDto } from '../storage/presigned-upload.dto';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { ProfilesService } from './profiles.service';

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
const storageKey = `profiles/${userId}/avatar/${imageId}.webp`;
const publicUrl = `https://storage.vedora.vn/vedora-profiles/${storageKey}`;
const presigned: PresignedUploadDto = {
  url: 'https://storage.vedora.vn/vedora-profiles/profiles/x?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'content-type': 'image/webp' },
  expiresAt: new Date('2026-09-28T09:00:00Z'),
};

describe('ProfilesService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let storage: DeepMockProxy<StorageService>;
  let service: ProfilesService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = mockDeep<PrismaService>();
    storage = mockDeep<StorageService>();
    storage.isConfigured.mockReturnValue(true);
    service = new ProfilesService(prisma, storage);
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

  it('presigns an upload scoped to the owner, kind, type and size', async () => {
    storage.presignUpload.mockResolvedValue(presigned);
    const result = await service.createImageUpload(userId, {
      kind: ProfileImageKind.COVER,
      contentType: 'image/webp',
      sizeBytes: 1000,
    });
    const key = `profiles/${userId}/cover/${result.id}.webp`;
    expect(storage.presignUpload).toHaveBeenCalledWith(
      StorageTarget.Profiles,
      key,
      'image/webp',
      1000,
    );
    expect(
      prisma.profileImageUpload.create.mock.calls[0][0].data,
    ).toMatchObject({ id: result.id, ownerId: userId, storageKey: key });
    expect(result.upload).toBe(presigned);
  });

  it('refuses images over the size limit before presigning', async () => {
    await expect(
      service.createImageUpload(userId, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/webp',
        sizeBytes: 5 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(storage.presignUpload).not.toHaveBeenCalled();
  });

  it('only activates a confirmed upload owned by the caller', async () => {
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce(null);
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const waiting: ProfileImageUpload = {
      id: imageId,
      ownerId: userId,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.WAITING_UPLOAD,
      storageKey,
      createdAt: new Date(),
    };
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce(waiting);
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.profileImageUpload.findFirst.mockResolvedValueOnce({
      ...waiting,
      status: ProfileImageStatus.READY,
    });
    storage.publicObjectUrl.mockReturnValue(publicUrl);
    await service.activateImage(userId, imageId);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { avatarUrl: publicUrl },
    });
  });

  it('marks only a waiting upload with that key ready', async () => {
    prisma.profileImageUpload.updateMany.mockResolvedValue({ count: 1 });
    await service.markImageUploaded(storageKey);
    expect(prisma.profileImageUpload.updateMany).toHaveBeenCalledWith({
      where: { storageKey, status: ProfileImageStatus.WAITING_UPLOAD },
      data: { status: ProfileImageStatus.READY },
    });
  });

  it('keeps active images and purges old unused uploads', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const upload: ProfileImageUpload = {
      id: imageId,
      ownerId: userId,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.READY,
      storageKey,
      createdAt: old,
    };
    prisma.profileImageUpload.findMany.mockResolvedValue([
      upload,
      { ...upload, id: viewerId, storageKey: 'profiles/unused.webp' },
    ]);
    prisma.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await service.purgeUnusedImages();
    expect(storage.delete).toHaveBeenCalledWith(
      StorageTarget.Profiles,
      'profiles/unused.webp',
    );
    expect(storage.delete).not.toHaveBeenCalledWith(
      StorageTarget.Profiles,
      storageKey,
    );
    expect(prisma.profileImageUpload.delete).toHaveBeenCalledWith({
      where: { id: viewerId },
    });
  });
});
