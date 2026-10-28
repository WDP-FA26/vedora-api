import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createPost, createUser } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import {
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostStatus,
  type User,
} from '../mongo/models';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostFeedService, interleave } from './post-feed.service';
import { PostSearchIndexService } from './post-search-index.service';

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
  let app: INestApplication;
  let db: MongoService;
  let posts: Model<Post>;
  let likes: Model<PostLike>;
  let bookmarks: Model<PostBookmark>;
  let qdrant: DeepMockProxy<QdrantService>;
  let service: PostFeedService;
  let viewer: User;
  let liked: Post;
  let saved: Post;
  let new1: Post;
  let new2: Post;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('feed'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    const modelOf = <T>(name: string) => app.get<Model<T>>(getModelToken(name));
    posts = modelOf(Post.name);
    likes = modelOf(PostLike.name);
    bookmarks = modelOf(PostBookmark.name);
    viewer = await createUser(db, { username: 'viewer' });
    const author = await createUser(db, { username: 'author' });
    // Published newest first: new-2, new-1, then the older posts.
    new2 = await createPost(db, {
      authorId: author.id,
      publishedAt: new Date('2026-10-26T12:00:00Z'),
    });
    new1 = await createPost(db, {
      authorId: author.id,
      publishedAt: new Date('2026-10-26T11:00:00Z'),
    });
    liked = await createPost(db, {
      authorId: author.id,
      publishedAt: new Date('2026-10-20T00:00:00Z'),
    });
    saved = await createPost(db, {
      authorId: author.id,
      publishedAt: new Date('2026-10-19T00:00:00Z'),
    });
    // A post of the viewer's own, and one published after `asOf`.
    await createPost(db, {
      authorId: viewer.id,
      publishedAt: new Date('2026-10-26T10:00:00Z'),
    });
    await createPost(db, {
      authorId: author.id,
      publishedAt: new Date('2026-10-28T00:00:00Z'),
    });
  });
  beforeEach(async () => {
    for (const model of [likes, bookmarks]) await model.deleteMany({});
    await likes.create({
      postId: liked.id,
      userId: viewer.id,
      createdAt: new Date('2026-10-26'),
    });
    await bookmarks.create({
      postId: saved.id,
      userId: viewer.id,
      createdAt: new Date('2026-10-25'),
    });

    qdrant = mockDeep<QdrantService>();
    qdrant.collectionExists.mockResolvedValue({ exists: true });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 2 } } } },
    } as never);
    const index = mockDeep<PostSearchIndexService>();
    Object.defineProperty(index, 'collection', { value: 'test_posts' });
    service = new PostFeedService(
      qdrant,
      index,
      posts,
      likes,
      bookmarks,
      app.get<Model<PostComment>>(getModelToken(PostComment.name)),
    );
    qdrant.retrieve.mockResolvedValue([
      { id: liked.id, vector: { dense: [0.1, 0.2] } },
    ] as never);
    qdrant.query.mockResolvedValue({
      points: ['s1', 's2', 's3', 's4', 's5'].map((id) => ({
        id,
        version: 0,
        score: 1,
      })),
    });
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('ranks recent posts by similarity to what the viewer liked, plus freshness', async () => {
    const ids = await service.feed(viewer.id, AS_OF, 10);

    expect(ids).toEqual([
      's1',
      's2',
      's3',
      's4',
      new2.id,
      's5',
      new1.id,
      liked.id,
      saved.id,
    ]);
    expect(qdrant.retrieve).toHaveBeenCalledWith('test_posts', {
      ids: [liked.id, saved.id],
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
            { key: 'authorId', match: { value: viewer.id } },
            { has_id: [liked.id, saved.id] },
          ],
        },
      },
      limit: 10,
    });
  });

  it('serves the newest posts of others, up to asOf, newest first', async () => {
    qdrant.retrieve.mockResolvedValue([]);
    const ids = await service.feed(viewer.id, AS_OF, 10);
    // Not the viewer's own post, nor the one published after asOf.
    expect(ids).toEqual([new2.id, new1.id, liked.id, saved.id]);
  });

  it('reads taste from interactions up to asOf, so later pages rank alike', async () => {
    await likes.create({
      postId: new1.id,
      userId: viewer.id,
      createdAt: new Date(AS_OF.getTime() + 1000),
    });

    await service.feed(viewer.id, AS_OF, 10);

    expect(qdrant.retrieve).toHaveBeenCalledWith(
      'test_posts',
      expect.objectContaining({ ids: [liked.id, saved.id] }),
    );
  });

  it('ignores interactions with posts that are no longer published', async () => {
    await posts.updateOne(
      { _id: saved.id },
      { $set: { status: PostStatus.PROCESSING } },
    );

    await service.feed(viewer.id, AS_OF, 10);

    expect(qdrant.retrieve).toHaveBeenCalledWith(
      'test_posts',
      expect.objectContaining({ ids: [liked.id] }),
    );
    await posts.updateOne(
      { _id: saved.id },
      { $set: { status: PostStatus.PUBLISHED } },
    );
  });

  it('serves the newest posts to a viewer with no interactions', async () => {
    await likes.deleteMany({});
    await bookmarks.deleteMany({});

    expect(await service.feed(viewer.id, AS_OF, 10)).toEqual([
      new2.id,
      new1.id,
      liked.id,
      saved.id,
    ]);
    expect(qdrant.query).not.toHaveBeenCalled();
  });

  it('skips Qdrant when none of the liked posts has a point', async () => {
    qdrant.retrieve.mockResolvedValue([]);

    await service.feed(viewer.id, AS_OF, 10);
    expect(qdrant.query).not.toHaveBeenCalled();
  });

  it('falls back to the newest posts when Qdrant fails', async () => {
    qdrant.query.mockRejectedValue(new Error('unreachable'));

    expect(await service.feed(viewer.id, AS_OF, 10)).toEqual([
      new2.id,
      new1.id,
      liked.id,
      saved.id,
    ]);
  });
});
