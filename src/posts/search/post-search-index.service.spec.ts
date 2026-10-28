import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createMedia, createPost, createUser } from '../../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../test/mongo-test-db.js';
import {
  MediaAsset,
  Post,
  PostStatus,
  PostType,
  type User,
} from '../../mongo/models.js';
import { MongoModule } from '../../mongo/mongo.module.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import { PostEmbeddingsService } from './post-embeddings.service.js';
import { chunkText, PostSearchIndexService } from './post-search-index.service.js';

describe('PostSearchIndexService', () => {
  let app: INestApplication;
  let db: MongoService;
  let posts: Model<Post>;
  let qdrant: DeepMockProxy<QdrantService>;
  let embeddings: DeepMockProxy<PostEmbeddingsService>;
  let service: PostSearchIndexService;
  let author: User;
  let post: Post;

  const reload = () =>
    posts
      .findOne({ _id: post.id })
      .exec()
      .then((row) => {
        if (!row) throw new Error('post missing');
        return row;
      });
  const setPost = (fields: Partial<Post>) =>
    posts.updateOne({ _id: post.id }, { $set: fields }).exec();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('searchindex'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    posts = app.get(getModelToken(Post.name));
    author = await createUser(db);
  });
  beforeEach(async () => {
    await db.connection.collections.posts.deleteMany({});
    await db.connection.collections.media_assets.deleteMany({});
    post = await createPost(db, {
      authorId: author.id,
      body: 'Đậu hũ sốt cà',
      publishedAt: new Date('2026-10-20T00:00:00.000Z'),
    });
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
    service = new PostSearchIndexService(
      qdrant,
      embeddings,
      new ConfigService({ QDRANT_POSTS_COLLECTION: 'test_posts' }),
      posts,
      app.get<Model<MediaAsset>>(getModelToken(MediaAsset.name)),
    );
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('indexes published posts that are not indexed yet, keyed by post id', async () => {
    await service.drain();

    expect(embeddings.embedPosts).toHaveBeenCalledWith(['Đậu hũ sốt cà']);
    const operation = qdrant.upsert.mock.calls[0][1];
    if (!('points' in operation)) throw new Error('expected points');
    expect(operation.points).toHaveLength(1);
    const [point] = operation.points;
    expect(point.id).toBe(post.id);
    expect(point.payload).toEqual({
      postId: post.id,
      authorId: author.id,
      publishedAt: 1_792_454_400,
    });
    expect(point.vector).toMatchObject({
      dense: [0.1, 0.2, 0.3, 0.4],
      bm25: { text: post.body },
      bm25_folded: { text: post.body },
    });
    expect((await reload()).searchIndexedAt).toBeInstanceOf(Date);
  });

  it('does not index posts again, nor drafts, nor blogs', async () => {
    await createPost(db, {
      authorId: author.id,
      type: PostType.BLOG,
      body: 'blog',
    });
    await createPost(db, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      publishedAt: null,
    });
    await service.drain();
    await service.drain();

    expect(embeddings.embedPosts).toHaveBeenCalledTimes(1);
  });

  it("embeds what a post's videos say after its body", async () => {
    await createMedia(db, {
      postId: post.id,
      transcript: 'Hôm nay mình nấu đậu hũ',
    });

    await service.drain();

    expect(embeddings.embedPosts).toHaveBeenCalledWith([
      'Đậu hũ sốt cà\nHôm nay mình nấu đậu hũ',
    ]);
  });

  it('embeds a long post in chunks and keeps their mean as its vector', async () => {
    await createMedia(db, {
      postId: post.id,
      transcript: 'à '.repeat(1000).trim(),
    });
    embeddings.embedPosts.mockImplementationOnce((chunks) =>
      Promise.resolve(chunks.map((_, i) => (i === 0 ? [1, 0] : [0, 1]))),
    );

    await service.drain();

    const [chunks] = embeddings.embedPosts.mock.calls[0];
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
    const operation = qdrant.upsert.mock.calls[0][1];
    if (!('points' in operation)) throw new Error('expected points');
    const vector = operation.points[0].vector as { dense: number[] };
    expect(vector.dense[0]).toBeCloseTo(Math.SQRT1_2);
    expect(vector.dense[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('marks a post with neither text nor speech indexed without a point', async () => {
    await setPost({ body: null });

    await service.drain();

    expect(embeddings.embedPosts).not.toHaveBeenCalled();
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect((await reload()).searchIndexedAt).toBeInstanceOf(Date);
  });

  it('leaves a post edited while it was indexed for the next run', async () => {
    embeddings.embedPosts.mockImplementationOnce(async (bodies) => {
      await setPost({ body: 'Đã sửa' });
      return bodies.map(() => [0.1, 0.2, 0.3, 0.4]);
    });

    await service.drain();

    expect((await reload()).searchIndexedAt).toBeNull();
  });

  it('leaves posts unindexed when embedding fails, for the next run', async () => {
    embeddings.embedPosts.mockRejectedValueOnce(new Error('OpenRouter down'));

    await expect(service.drain()).rejects.toThrow('OpenRouter down');
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect((await reload()).searchIndexedAt).toBeNull();
  });

  it('creates a missing collection and marks every post for reindexing', async () => {
    await service.drain();
    expect((await reload()).searchIndexedAt).toBeInstanceOf(Date);
    qdrant.collectionExists.mockResolvedValue({ exists: false });
    const fresh = new PostSearchIndexService(
      qdrant,
      embeddings,
      new ConfigService({ QDRANT_POSTS_COLLECTION: 'test_posts' }),
      posts,
      app.get<Model<MediaAsset>>(getModelToken(MediaAsset.name)),
    );

    await fresh.drain();
    await fresh.drain();

    expect(qdrant.createCollection).toHaveBeenCalledOnce();
    // The first drain marked the indexed post for reindexing and embedded it
    // again; the second found nothing to do.
    expect(embeddings.embedPosts).toHaveBeenCalledTimes(2);
  });

  it('refuses a collection built for another embedding size', async () => {
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 1536 } } } },
    } as never);

    await expect(service.drain()).rejects.toThrow('does not hold 4-dimension');
  });

  it('removes a deleted post without throwing when Qdrant fails', async () => {
    qdrant.delete.mockRejectedValueOnce(new Error('unreachable'));

    await expect(service.remove(post.id)).resolves.toBeUndefined();
    expect(qdrant.delete).toHaveBeenCalledWith('test_posts', {
      wait: true,
      points: [post.id],
    });
  });
});

describe('chunkText', () => {
  it('cuts at the last space before the limit', () => {
    expect(chunkText('một hai ba bốn', 8)).toEqual(['một hai', 'ba bốn']);
  });

  it('cuts mid-word only when a piece has no space', () => {
    expect(chunkText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('returns nothing for blank text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('keeps every character of a long text but the whitespace it cuts at', () => {
    // Words and line breaks, then a 3,500-character run with no space.
    const text =
      Array.from({ length: 4000 }, (_, i) => `từ${i}`).join(' ') +
      '\n' +
      'x'.repeat(3500);

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
    const visible = (value: string) => value.replace(/\s/g, '');
    expect(visible(chunks.join(''))).toBe(visible(text));
  });
});
