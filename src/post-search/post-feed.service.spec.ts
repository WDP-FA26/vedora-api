import { ConfigService } from '@nestjs/config';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import { interleave, PostFeedService } from './post-feed.service';
import { PostSearchIndexService } from './post-search-index.service';

const VIEWER = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const AS_OF = new Date('2026-10-27T00:00:00.000Z');
const NOW = 1_793_059_200;

describe('interleave', () => {
  it('gives every fifth slot to the newest posts', () => {
    expect(interleave(['a', 'b', 'c', 'd', 'e', 'f'], ['x', 'y'], 5)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'x',
      'e',
      'f',
      'y',
    ]);
  });

  it('skips repeats and lets either list fill in for the other', () => {
    expect(interleave(['a', 'x'], ['x', 'y', 'z'], 2)).toEqual([
      'a',
      'x',
      'y',
      'z',
    ]);
    expect(interleave([], ['x', 'y'], 5)).toEqual(['x', 'y']);
  });
});

describe('PostFeedService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let qdrant: DeepMockProxy<QdrantService>;
  let service: PostFeedService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    qdrant = mockDeep<QdrantService>();
    qdrant.collectionExists.mockResolvedValue({ exists: true });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 2 } } } },
    } as never);
    const embeddings = mockDeep<PostEmbeddingsService>();
    Object.defineProperty(embeddings, 'dimensions', { value: 2 });
    const index = new PostSearchIndexService(
      prisma,
      qdrant,
      embeddings,
      new ConfigService({ QDRANT_POSTS_COLLECTION: 'test_posts' }),
    );
    service = new PostFeedService(prisma, qdrant, index);

    prisma.postLike.findMany.mockResolvedValue([
      { postId: 'liked-1', createdAt: new Date('2026-10-26') },
    ] as never);
    prisma.postBookmark.findMany.mockResolvedValue([
      { postId: 'saved-1', createdAt: new Date('2026-10-25') },
    ] as never);
    prisma.postComment.findMany.mockResolvedValue([]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'new-1' },
      { id: 'new-2' },
    ] as never);
    qdrant.retrieve.mockResolvedValue([
      { id: 'liked-1', vector: { dense: [0.1, 0.2] } },
    ] as never);
    qdrant.query.mockResolvedValue({
      points: ['s1', 's2', 's3', 's4', 's5'].map((id) => ({
        id,
        version: 0,
        score: 1,
      })),
    });
  });

  it('ranks recent posts by similarity to what the viewer liked, plus freshness', async () => {
    const ids = await service.feed(VIEWER, AS_OF, 10);

    expect(ids).toEqual(['s1', 's2', 's3', 's4', 'new-1', 's5', 'new-2']);
    expect(qdrant.retrieve).toHaveBeenCalledWith('test_posts', {
      ids: ['liked-1', 'saved-1'],
      with_vector: ['dense'],
      with_payload: false,
    });
    const [, request] = qdrant.query.mock.calls[0];
    expect(request).toMatchObject({
      prefetch: {
        query: {
          recommend: { positive: [[0.1, 0.2]], strategy: 'best_score' },
        },
        using: 'dense',
        filter: {
          must: [
            {
              key: 'publishedAt',
              range: { gte: NOW - 7 * 24 * 60 * 60, lte: NOW },
            },
          ],
          must_not: [
            { key: 'authorId', match: { value: VIEWER } },
            { has_id: ['liked-1', 'saved-1'] },
          ],
        },
      },
      query: {
        formula: {
          sum: [
            '$score',
            {
              mult: [
                0.3,
                {
                  exp_decay: {
                    x: 'publishedAt',
                    target: NOW,
                    scale: 2 * 24 * 60 * 60,
                  },
                },
              ],
            },
          ],
        },
      },
      limit: 10,
    });
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PUBLISHED',
          publishedAt: { lte: AS_OF },
          authorId: { not: VIEWER },
        },
        take: 10,
      }),
    );
  });

  it('serves the newest posts to a viewer with no interactions', async () => {
    prisma.postLike.findMany.mockResolvedValue([]);
    prisma.postBookmark.findMany.mockResolvedValue([]);

    expect(await service.feed(VIEWER, AS_OF, 10)).toEqual(['new-1', 'new-2']);
    expect(qdrant.query).not.toHaveBeenCalled();
  });

  it('skips Qdrant when none of the liked posts has a point', async () => {
    qdrant.retrieve.mockResolvedValue([]);

    expect(await service.feed(VIEWER, AS_OF, 10)).toEqual(['new-1', 'new-2']);
    expect(qdrant.query).not.toHaveBeenCalled();
  });

  it('falls back to the newest posts when Qdrant fails', async () => {
    qdrant.query.mockRejectedValue(new Error('unreachable'));

    expect(await service.feed(VIEWER, AS_OF, 10)).toEqual(['new-1', 'new-2']);
  });
});
