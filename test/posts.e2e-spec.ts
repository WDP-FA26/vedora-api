import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { PostSearchIndexService } from '../src/post-search/post-search-index.service';
import { PostSearchService } from '../src/post-search/post-search.service';
import {
  type Post,
  PostStatus,
  type Stored,
  PostType,
  type User,
  UserRole,
} from '../src/mongo/models';
import { deleteWithReferences } from '../src/mongo/relations';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createPost, createUser } from './fixtures';

describe('Post reads and admin posts (e2e)', () => {
  const postSearch = mockDeep<PostSearchService>();
  const searchIndex = mockDeep<PostSearchIndexService>();
  let e2e: E2eApp;
  let admin: User;
  let author: User;
  let adminToken: string;
  let userToken: string;
  let post: Post;
  const server = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp('posts_e2e', (builder) =>
      builder
        .overrideProvider(PostSearchService)
        .useValue(postSearch)
        .overrideProvider(PostSearchIndexService)
        .useValue(searchIndex),
    );
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    author = await createUser(e2e.mongo, { username: 'vedora.chef' });
    [adminToken, userToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(author),
    ]);
  });
  beforeEach(async () => {
    mockReset(postSearch);
    mockReset(searchIndex);
    await e2e.mongo.withTransaction((session) =>
      deleteWithReferences(e2e.mongo.db, session, 'posts', {
        authorId: author.id,
      }),
    );
    post = await createPost(e2e.mongo, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      body: 'Đậu hũ sốt cà',
      publishedAt: null,
    });
  });
  afterAll(async () => {
    await e2e.close();
  });

  it.each([
    ['get', ''],
    ['delete', '/{id}'],
  ] as const)('keeps %s /admin/posts%s to admins', async (method, suffix) => {
    const path = `/api/v1/admin/posts${suffix.replace('{id}', post.id)}`;
    await request(server())[method](path).expect(401);
    await request(server())
      [method](path)
      .auth(userToken, { type: 'bearer' })
      .expect(403);
    expect(
      await e2e.mongo.db
        .collection<Stored<Post>>('posts')
        .findOne({ _id: post.id }),
    ).not.toBe(null);
  });

  it('lists posts that are not published', async () => {
    const response = await request(server())
      .get('/api/v1/admin/posts?limit=50')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({
      items: [{ id: post.id, status: PostStatus.PROCESSING }],
      meta: { totalItems: 1, limit: 50 },
    });
  });

  it("deletes another user's post", async () => {
    await request(server())
      .delete(`/api/v1/admin/posts/${post.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    expect(
      await e2e.mongo.db
        .collection<Stored<Post>>('posts')
        .findOne({ _id: post.id }),
    ).toBeNull();
    expect(searchIndex.remove).toHaveBeenCalledWith(post.id);
  });

  it('limits a post body to 250 words', async () => {
    const words = (count: number) => Array(count).fill('rau').join(' ');
    const response = await request(server())
      .post('/api/v1/posts')
      .auth(userToken, { type: 'bearer' })
      .send({ type: PostType.POST, body: words(251) })
      .expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'body must be at most 250 words',
    ]);
  });

  it('searches published posts in match order for guests', async () => {
    const published = await createPost(e2e.mongo, { authorId: author.id });
    const deleted = randomUUID();
    postSearch.search.mockResolvedValue({
      ids: [deleted, published.id],
      hasMore: true,
    });
    postSearch.prune.mockResolvedValue();

    const response = await request(server())
      .get('/api/v1/posts/search')
      .query({ q: '  dau hu  ', limit: 2, cursor: 4 })
      .expect(200);

    expect(postSearch.search).toHaveBeenCalledWith('dau hu', 4, 2);
    expect(response.body).toMatchObject({
      items: [{ id: published.id }],
      nextCursor: '6',
    });
    // The deleted post was indexed before it was deleted.
    expect(postSearch.prune).toHaveBeenCalledWith([deleted]);
  });

  it('rejects an empty search or one past the search depth', async () => {
    await request(server())
      .get('/api/v1/posts/search')
      .query({ q: '   ' })
      .expect(400);
    await request(server())
      .get('/api/v1/posts/search')
      .query({ q: 'phở', cursor: 201 })
      .expect(400);
    expect(postSearch.search).not.toHaveBeenCalled();
  });

  it('lets guests read a published post but not one still processing', async () => {
    await request(server()).get(`/api/v1/posts/${post.id}`).expect(404);
    await e2e.mongo.db
      .collection<Stored<Post>>('posts')
      .updateOne(
        { _id: post.id },
        { $set: { status: PostStatus.PUBLISHED, publishedAt: new Date() } },
      );
    const response = await request(server())
      .get(`/api/v1/posts/${post.id}`)
      .expect(200);
    expect(response.body).toMatchObject({ id: post.id, isLiked: false });
  });

  it('accepts view batches from guests', async () => {
    await request(server())
      .post('/api/v1/posts/views')
      .send({ postIds: [post.id] })
      .expect(204);
    await request(server())
      .post('/api/v1/posts/views')
      .send({ postIds: ['not-a-uuid'] })
      .expect(400);
  });

  it('reposts idempotently and requires login', async () => {
    await e2e.mongo.db
      .collection<Stored<Post>>('posts')
      .updateOne(
        { _id: post.id },
        { $set: { status: PostStatus.PUBLISHED, publishedAt: new Date() } },
      );
    await request(server()).put(`/api/v1/posts/${post.id}/repost`).expect(401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(server())
        .put(`/api/v1/posts/${post.id}/repost`)
        .auth(userToken, { type: 'bearer' })
        .expect(200);
      expect(response.body).toEqual({
        postId: post.id,
        isReposted: true,
        repostCount: 1,
      });
    }
  });

  it('validates reports and keeps the report queue to admins', async () => {
    await e2e.mongo.db
      .collection<Stored<Post>>('posts')
      .updateOne(
        { _id: post.id },
        { $set: { status: PostStatus.PUBLISHED, publishedAt: new Date() } },
      );
    await request(server())
      .post(`/api/v1/posts/${post.id}/report`)
      .auth(adminToken, { type: 'bearer' })
      .send({ reason: 'BORING' })
      .expect(400);
    await request(server())
      .post(`/api/v1/posts/${post.id}/report`)
      .auth(adminToken, { type: 'bearer' })
      .send({ reason: 'SPAM', details: '  quảng cáo  ' })
      .expect(201);
    expect(
      await e2e.mongo.db.collection('post_reports').findOne({}),
    ).toMatchObject({
      reason: 'SPAM',
      details: 'quảng cáo',
    });
    await request(server())
      .get('/api/v1/admin/reports')
      .auth(userToken, { type: 'bearer' })
      .expect(403);
  });

  it('answers 404 when deleting an unknown post', async () => {
    await request(server())
      .delete(`/api/v1/admin/posts/${randomUUID()}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
  });
});
