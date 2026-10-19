import { NotFoundException } from '@nestjs/common';
import {
  CaptionStatus,
  MediaStatus,
  PostStatus,
  PostType,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { pendingMedia } from '../media/media.fixtures';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPostsService } from './admin-posts.service';

const postId = 'f1a2d3e4-0000-4000-8000-000000000001';
const now = new Date('2026-10-07T08:00:00Z');
const media = {
  ...pendingMedia,
  postId,
  status: MediaStatus.READY,
  captionStatus: CaptionStatus.READY,
  captionLanguage: 'vi',
  captions: [
    {
      id: 'c1a2d3e4-0000-4000-8000-000000000001',
      mediaId: pendingMedia.id,
      languageCode: 'vi',
      name: 'Tiếng Việt',
      isOriginal: true,
      url: 'https://res.cloudinary.com/demo/raw/upload/vi.vtt',
      createdAt: now,
    },
  ],
};
const row = {
  id: postId,
  authorId: pendingMedia.ownerId,
  type: PostType.POST,
  status: PostStatus.PROCESSING,
  body: 'Đậu hũ sốt cà',
  publishedAt: null,
  createdAt: now,
  updatedAt: now,
  author: {
    id: pendingMedia.ownerId,
    username: 'vedora.chef',
    fullName: 'Vedora Chef',
    avatarUrl: null,
  },
  media: [media],
  viewCount: 7,
  searchIndexedAt: null,
  reposts: [],
  bookmarks: [],
  _count: { comments: 2, likes: 5, reposts: 1 },
};

describe('AdminPostsService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: AdminPostsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    const mediaService = mockDeep<MediaService>();
    mediaService.toResponse.mockImplementation((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      failureReason: item.failureReason,
      publicId: item.publicId,
      playbackUrl: null,
      posterUrl: null,
      durationSec: item.durationSec,
      aspectRatio: item.aspectRatio,
      captions: (item.captions ?? []).map(
        ({ languageCode, name, isOriginal, url }) => ({
          languageCode,
          name,
          isOriginal,
          url,
        }),
      ),
    }));
    service = new AdminPostsService(prisma, mediaService);
    prisma.$transaction.mockImplementation((run: unknown) =>
      Promise.all(run as Promise<unknown>[]),
    );
  });

  it('lists posts of every status with their caption state', async () => {
    prisma.post.findMany.mockResolvedValue([row] as never);
    prisma.post.count.mockResolvedValue(1);

    const page = await service.findAll({ page: 1, limit: 20 });

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 20 }),
    );
    expect(page.meta.totalItems).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: postId,
      status: PostStatus.PROCESSING,
      commentCount: 2,
      likeCount: 5,
      media: [{ captionStatus: CaptionStatus.READY, captionLanguage: 'vi' }],
    });
  });

  it('filters by status', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.findAll({ page: 1, limit: 20, status: PostStatus.FAILED });

    expect(prisma.post.count).toHaveBeenCalledWith({
      where: { status: PostStatus.FAILED },
    });
  });

  it("includes each video's caption tracks in a single post", async () => {
    prisma.post.findUnique.mockResolvedValue(row as never);

    const post = await service.findOne(postId);

    expect(post.media[0]).toMatchObject({
      captionStatus: CaptionStatus.READY,
      captions: [{ languageCode: 'vi', isOriginal: true }],
    });
  });

  it('answers 404 for an unknown post', async () => {
    prisma.post.findUnique.mockResolvedValue(null);
    await expect(service.findOne(postId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
