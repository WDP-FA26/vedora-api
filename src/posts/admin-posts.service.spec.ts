import { NotFoundException } from '@nestjs/common';
import {
  CaptionStatus,
  MediaStatus,
  PostStatus,
  PostType,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CaptionService } from '../media/caption.service';
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
  playbackId: 'playback-1',
  captionStatus: CaptionStatus.READY,
  captionLanguage: 'vi',
  captionTrackId: 'track-1',
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
  reposts: [],
  _count: { comments: 2, likes: 5, reposts: 1 },
};
const track = {
  id: 'track-1',
  languageCode: 'vi',
  name: 'Tiếng Việt',
  isOriginal: true,
  url: 'https://stream.mux.com/playback-1/text/track-1.vtt',
};

describe('AdminPostsService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let captions: DeepMockProxy<CaptionService>;
  let service: AdminPostsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    captions = mockDeep<CaptionService>();
    const mediaService = mockDeep<MediaService>();
    mediaService.toResponse.mockImplementation((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      failureReason: item.failureReason,
      playbackId: item.playbackId,
      durationSec: item.durationSec,
      aspectRatio: item.aspectRatio,
    }));
    service = new AdminPostsService(prisma, mediaService, captions);
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

  it("adds each video's caption tracks to a single post", async () => {
    prisma.post.findUnique.mockResolvedValue(row as never);
    captions.listTracks.mockResolvedValue([track]);

    const post = await service.findOne(postId);

    expect(captions.listTracks).toHaveBeenCalledWith(media);
    expect(post.media[0].captions).toEqual([track]);
  });

  it('answers 404 for an unknown post', async () => {
    prisma.post.findUnique.mockResolvedValue(null);
    await expect(service.findOne(postId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
