import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import {
  createMedia,
  createPost,
  createUser,
} from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';
import {
  MediaAsset,
  Post,
  PostStatus,
  PostType,
  type User,
} from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import { QdrantService } from '../../../../src/qdrant/qdrant.service.js';
import {
  chunkText,
  PostSearchIndexService,
} from '../../../../src/posts/search/post-search-index.service.js';

describe('PostSearchIndexService', () => {
  let app: INestApplication;
  let db: MongoService;
  let posts: Model<Post>;
  let qdrant: DeepMockProxy<QdrantService>;
  let ai: DeepMockProxy<AiService>;
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
    ai = mockDeep<AiService>();
    ai.embedMany.mockImplementation(({ values }) =>
      Promise.resolve({
        embeddings: values.map(() => [0.1, 0.2, 0.3, 0.4]),
      } as never),
    );
    qdrant.collectionExists.mockResolvedValue({ exists: true });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 4 } } } },
    } as never);
    service = new PostSearchIndexService(
      qdrant,
      ai,
      new ConfigService({
        QDRANT_POSTS_COLLECTION: 'test_posts',
        POST_SEARCH_EMBEDDING_DIMENSIONS: 4,
      }),
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

    expect(ai.embedMany).toHaveBeenCalledWith({
      model: 'posts',
      label: 'index-posts',
      values: ['title: none | text: Đậu hũ sốt cà'],
    });
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

    expect(ai.embedMany).toHaveBeenCalledTimes(1);
  });

  it("embeds what a post's videos say after its body", async () => {
    await createMedia(db, {
      postId: post.id,
      transcript: 'Hôm nay mình nấu đậu hũ',
    });

    await service.drain();

    expect(ai.embedMany).toHaveBeenCalledWith({
      model: 'posts',
      label: 'index-posts',
      values: ['title: none | text: Đậu hũ sốt cà\nHôm nay mình nấu đậu hũ'],
    });
  });

  it('embeds a long post in chunks and keeps their mean as its vector', async () => {
    await createMedia(db, {
      postId: post.id,
      transcript: 'à '.repeat(1000).trim(),
    });
    ai.embedMany.mockImplementationOnce(({ values }) =>
      Promise.resolve({
        embeddings: values.map((_, i) => (i === 0 ? [1, 0] : [0, 1])),
      } as never),
    );

    await service.drain();

    const [{ values: chunks }] = ai.embedMany.mock.calls[0];
    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) => chunk.replace(/^title: none \| text: /, '').length <= 1500,
      ),
    ).toBe(true);
    const operation = qdrant.upsert.mock.calls[0][1];
    if (!('points' in operation)) throw new Error('expected points');
    const vector = operation.points[0].vector as { dense: number[] };
    expect(vector.dense[0]).toBeCloseTo(Math.SQRT1_2);
    expect(vector.dense[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('marks a post with neither text nor speech indexed without a point', async () => {
    await setPost({ body: null });

    await service.drain();

    expect(ai.embedMany).not.toHaveBeenCalled();
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect((await reload()).searchIndexedAt).toBeInstanceOf(Date);
  });

  it('leaves a post edited while it was indexed for the next run', async () => {
    ai.embedMany.mockImplementationOnce(async ({ values }) => {
      await setPost({ body: 'Đã sửa' });
      return {
        embeddings: values.map(() => [0.1, 0.2, 0.3, 0.4]),
      } as never;
    });

    await service.drain();

    expect((await reload()).searchIndexedAt).toBeNull();
  });

  it('leaves posts unindexed when embedding fails, for the next run', async () => {
    ai.embedMany.mockRejectedValueOnce(new Error('OpenRouter down'));

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
      ai,
      new ConfigService({
        QDRANT_POSTS_COLLECTION: 'test_posts',
        POST_SEARCH_EMBEDDING_DIMENSIONS: 4,
      }),
      posts,
      app.get<Model<MediaAsset>>(getModelToken(MediaAsset.name)),
    );

    await fresh.drain();
    await fresh.drain();

    expect(qdrant.createCollection).toHaveBeenCalledOnce();
    expect(ai.embedMany).toHaveBeenCalledTimes(2);
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
