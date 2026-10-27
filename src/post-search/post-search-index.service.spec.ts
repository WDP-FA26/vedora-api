import { ConfigService } from '@nestjs/config';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import { PostSearchIndexService } from './post-search-index.service';

const POST = {
  id: 'f1a2d3e4-0000-4000-8000-000000000001',
  authorId: '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10',
  body: 'Đậu hũ sốt cà',
  publishedAt: new Date('2026-10-20T00:00:00.000Z'),
  media: [] as { transcript: string | null }[],
};

describe('PostSearchIndexService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let qdrant: DeepMockProxy<QdrantService>;
  let embeddings: DeepMockProxy<PostEmbeddingsService>;
  let service: PostSearchIndexService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    qdrant = mockDeep<QdrantService>();
    embeddings = mockDeep<PostEmbeddingsService>();
    Object.defineProperty(embeddings, 'dimensions', { value: 4 });
    embeddings.embedPosts.mockImplementation((bodies) =>
      Promise.resolve(bodies.map(() => [0.1, 0.2, 0.3, 0.4])),
    );
    qdrant.collectionExists.mockResolvedValue({ exists: true });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 4 } } } },
    } as never);
    prisma.post.updateMany.mockResolvedValue({ count: 0 });
    service = new PostSearchIndexService(
      prisma,
      qdrant,
      embeddings,
      new ConfigService({ QDRANT_POSTS_COLLECTION: 'test_posts' }),
    );
  });

  it('indexes published posts that are not indexed yet, keyed by post id', async () => {
    prisma.post.findMany.mockResolvedValueOnce([POST] as never);

    await service.drain();

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: 'POST',
          status: 'PUBLISHED',
          searchIndexedAt: null,
        },
      }),
    );
    expect(embeddings.embedPosts).toHaveBeenCalledWith(['Đậu hũ sốt cà']);
    const operation = qdrant.upsert.mock.calls[0][1];
    if (!('points' in operation)) throw new Error('expected points');
    expect(operation.points).toHaveLength(1);
    const [point] = operation.points;
    expect(point.id).toBe(POST.id);
    expect(point.payload).toEqual({
      postId: POST.id,
      authorId: POST.authorId,
      publishedAt: 1_792_454_400,
    });
    expect(point.vector).toMatchObject({
      dense: [0.1, 0.2, 0.3, 0.4],
      bm25: { text: POST.body },
      bm25_folded: { text: POST.body },
    });
    const update = prisma.post.updateMany.mock.calls[0][0];
    expect(update?.where).toEqual({ id: { in: [POST.id] } });
    expect(update?.data.searchIndexedAt).toBeInstanceOf(Date);
  });

  it("embeds what a post's videos say after its body", async () => {
    prisma.post.findMany.mockResolvedValueOnce([
      { ...POST, media: [{ transcript: 'Hôm nay mình nấu đậu hũ' }] },
    ] as never);

    await service.drain();

    expect(embeddings.embedPosts).toHaveBeenCalledWith([
      'Đậu hũ sốt cà\nHôm nay mình nấu đậu hũ',
    ]);
  });

  it('marks a post with neither text nor speech indexed without a point', async () => {
    prisma.post.findMany.mockResolvedValueOnce([
      { ...POST, body: null },
    ] as never);

    await service.drain();

    expect(embeddings.embedPosts).not.toHaveBeenCalled();
    expect(qdrant.upsert).not.toHaveBeenCalled();
    const update = prisma.post.updateMany.mock.calls[0][0];
    expect(update?.where).toEqual({ id: { in: [POST.id] } });
  });

  it('leaves posts unindexed when embedding fails, for the next run', async () => {
    prisma.post.findMany.mockResolvedValueOnce([POST] as never);
    embeddings.embedPosts.mockRejectedValueOnce(new Error('OpenRouter down'));

    await expect(service.drain()).rejects.toThrow('OpenRouter down');
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('creates a missing collection and marks every post for reindexing', async () => {
    qdrant.collectionExists.mockResolvedValue({ exists: false });
    prisma.post.findMany.mockResolvedValue([]);

    await service.drain();
    await service.drain();

    expect(qdrant.createCollection).toHaveBeenCalledOnce();
    expect(prisma.post.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { searchIndexedAt: { not: null } },
      data: { searchIndexedAt: null },
    });
  });

  it('refuses a collection built for another embedding size', async () => {
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 1536 } } } },
    } as never);

    await expect(service.drain()).rejects.toThrow('does not hold 4-dimension');
  });

  it('removes a deleted post without throwing when Qdrant fails', async () => {
    qdrant.delete.mockRejectedValueOnce(new Error('unreachable'));

    await expect(service.remove(POST.id)).resolves.toBeUndefined();
    expect(qdrant.delete).toHaveBeenCalledWith('test_posts', {
      wait: true,
      points: [POST.id],
    });
  });
});
