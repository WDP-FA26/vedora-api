import { randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { CommentPageDto } from '../src/posts/dto/comment.dto.js';
import type { PostPageDto } from '../src/posts/dto/post-response.dto.js';
import {
  Post,
  PostComment,
  PostStatus,
  User,
  UserRole,
} from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createPost, createUser } from './fixtures.js';

describe('Post comments and likes (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let other: User;
  let admin: User;
  let token: string;
  let otherToken: string;
  let adminToken: string;
  let post: Post;
  let comment: { id: string };
  const server = () => e2e.app.getHttpServer();
  const posts = () => `/api/v1/posts/${post.id}`;
  const postsModel = () => e2e.mongo.connection.model<Post>(Post.name);
  const commentsModel = () =>
    e2e.mongo.connection.model<PostComment>(PostComment.name);
  const usersModel = () => e2e.mongo.connection.model<User>(User.name);
  const count = (collection: string) =>
    e2e.mongo.connection.collections[collection].countDocuments();

  const addComment = async (authorId: string, createdAt = new Date()) => {
    const id = randomUUID();
    await commentsModel().create({
      _id: id,
      postId: post.id,
      authorId,
      body: 'Bài viết hữu ích!',
      createdAt,
      updatedAt: createdAt,
    });
    return { id };
  };

  beforeAll(async () => {
    e2e = await createE2eApp('interactions_e2e');
    user = await createUser(e2e.mongo, { username: 'vedora.user' });
    other = await createUser(e2e.mongo, { username: 'vedora.other' });
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    [token, otherToken, adminToken] = await Promise.all([
      e2e.sign(user),
      e2e.sign(other),
      e2e.sign(admin),
    ]);
  });
  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      postsModel().deleteMany({ authorId: other.id }, { session }).exec(),
    );
    for (const collection of [
      'post_comments',
      'post_likes',
      'post_bookmarks',
    ] as const) {
      await e2e.mongo.connection.collections[collection].deleteMany({});
    }
    post = await createPost(e2e.mongo, {
      authorId: other.id,
      body: 'Plant based cooking',
    });
    comment = await addComment(user.id);
  });
  afterAll(async () => {
    await e2e.close();
  });

  it.each([
    ['post', 'comments'],
    ['patch', 'comments/{comment}'],
    ['delete', 'comments/{comment}'],
    ['put', 'like'],
    ['delete', 'like'],
  ] as const)('requires login for %s %s', async (method, path) => {
    await request(server())
      [method](`${posts()}/${path.replace('{comment}', comment.id)}`)
      .send({ body: 'Hello' })
      .expect(401);
  });

  it('creates a comment with a trimmed body and the authenticated author', async () => {
    const response = await request(server())
      .post(`${posts()}/comments`)
      .auth(token, { type: 'bearer' })
      .send({ body: '  Bài viết hữu ích!  ' })
      .expect(201);
    expect(response.body).toMatchObject({
      postId: post.id,
      body: 'Bài viết hữu ích!',
      author: { id: user.id, username: 'vedora.user' },
    });
    expect(response.body).not.toHaveProperty('authorId');
  });

  it.each([
    {},
    { body: '' },
    { body: ' \n\t ' },
    { body: null },
    { body: 123 },
    { body: ['hello'] },
    { body: 'a'.repeat(1001) },
    { body: 'hello', authorId: randomUUID() },
    { body: 'hello', parentId: randomUUID() },
  ])('rejects an invalid create/edit body: %j', async (body) => {
    for (const method of ['post', 'patch'] as const) {
      const path = method === 'post' ? 'comments' : `comments/${comment.id}`;
      await request(server())
        [method](`${posts()}/${path}`)
        .auth(token, { type: 'bearer' })
        .send(body)
        .expect(400);
    }
    expect(await commentsModel().countDocuments()).toBe(1);
  });

  it('accepts the maximum comment length', async () => {
    await request(server())
      .post(`${posts()}/comments`)
      .auth(token, { type: 'bearer' })
      .send({ body: 'a'.repeat(1000) })
      .expect(201);
  });

  it('allows the comment author to edit', async () => {
    await request(server())
      .patch(`${posts()}/comments/${comment.id}`)
      .auth(token, { type: 'bearer' })
      .send({ body: 'Updated' })
      .expect(200);
    const stored = await commentsModel().findOne({ _id: comment.id }).exec();
    expect(stored?.body).toBe('Updated');
  });

  it.each(['USER', 'ADMIN'] as const)(
    'rejects editing another author’s comment as %s',
    async (role) => {
      const foreign = await addComment(other.id);
      await request(server())
        .patch(`${posts()}/comments/${foreign.id}`)
        .auth(role === 'ADMIN' ? adminToken : token, { type: 'bearer' })
        .send({ body: 'Updated' })
        .expect(403);
      const stored = await commentsModel().findOne({ _id: foreign.id }).exec();
      expect(stored?.body).toBe('Bài viết hữu ích!');
    },
  );

  it.each(['comment author', 'post author', 'admin'])(
    'allows deletion by the %s',
    async (actor) => {
      const target =
        actor === 'comment author' ? comment : await addComment(user.id);
      // The post author is `other`; the comment is by `user` otherwise.
      const byToken =
        actor === 'post author'
          ? otherToken
          : actor === 'admin'
            ? adminToken
            : token;
      await request(server())
        .delete(`${posts()}/comments/${target.id}`)
        .auth(byToken, { type: 'bearer' })
        .expect(204);
      expect(
        await commentsModel().findOne({ _id: target.id }).exec(),
      ).toBeNull();
    },
  );

  it('rejects deletion by an unrelated account', async () => {
    const third = await createUser(e2e.mongo);
    await request(server())
      .delete(`${posts()}/comments/${comment.id}`)
      .auth(await e2e.sign(third), { type: 'bearer' })
      .expect(403);
    expect(await commentsModel().countDocuments()).toBe(1);
  });

  it.each(['patch', 'delete'] as const)(
    'returns 404 for a missing comment or one outside the supplied post (%s)',
    async (method) => {
      const elsewhere = await createPost(e2e.mongo, { authorId: other.id });
      await request(server())
        [method](`/api/v1/posts/${elsewhere.id}/comments/${comment.id}`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Updated' })
        .expect(404);
      expect(await commentsModel().countDocuments()).toBe(1);
    },
  );

  it('publicly lists comments with cursor pagination and excludes the extra row', async () => {
    const newer = await addComment(user.id, new Date(Date.now() + 1000));
    const newest = await addComment(user.id, new Date(Date.now() + 2000));
    const response = await request(server())
      .get(`${posts()}/comments?limit=2`)
      .expect(200);
    const page = response.body as CommentPageDto;
    expect(page.items.map(({ id }) => id)).toEqual([newest.id, newer.id]);
    expect(page.nextCursor).toBe(newer.id);
  });

  it('skips the cursor and returns null at the last page', async () => {
    const newer = await addComment(user.id, new Date(Date.now() + 1000));
    const response = await request(server())
      .get(`${posts()}/comments?cursor=${newer.id}&limit=2`)
      .expect(200);
    const page = response.body as CommentPageDto;
    expect(page.items.map(({ id }) => id)).toEqual([comment.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a cursor deleted or belonging to another post', async () => {
    await request(server())
      .get(`${posts()}/comments?cursor=${randomUUID()}`)
      .expect(400);
  });

  it.each(['limit=0', 'limit=51', 'cursor=invalid', 'page=1'])(
    'validates comment query %s',
    async (query) => {
      await request(server()).get(`${posts()}/comments?${query}`).expect(400);
    },
  );

  it.each([
    ['get', 'comments'],
    ['post', 'comments'],
    ['patch', 'comments/{comment}'],
    ['delete', 'comments/{comment}'],
    ['put', 'like'],
    ['delete', 'like'],
  ] as const)(
    'hides missing/non-published posts on %s %s',
    async (method, path) => {
      await postsModel()
        .updateOne(
          { _id: post.id },
          { $set: { status: PostStatus.PROCESSING } },
        )
        .exec();
      await request(server())
        [method](`${posts()}/${path.replace('{comment}', comment.id)}`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Hello' })
        .expect(404);
      expect(await count('post_likes')).toBe(0);
    },
  );

  it('likes idempotently without creating duplicate rows', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(server())
        .put(`${posts()}/like`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toEqual({
        postId: post.id,
        isLiked: true,
        likeCount: 1,
      });
    }
    expect(await count('post_likes')).toBe(1);
  });

  it('unlikes idempotently and only removes the caller’s like', async () => {
    for (const token_ of [token, otherToken]) {
      await request(server())
        .put(`${posts()}/like`)
        .auth(token_, { type: 'bearer' })
        .expect(200);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(server())
        .delete(`${posts()}/like`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toEqual({
        postId: post.id,
        isLiked: false,
        likeCount: 1,
      });
    }
  });

  it('saves a post idempotently', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(server())
        .put(`${posts()}/bookmark`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toEqual({ postId: post.id, isBookmarked: true });
    }
    expect(await count('post_bookmarks')).toBe(1);
  });

  it('does not save a missing or unpublished post', async () => {
    await postsModel()
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PROCESSING } })
      .exec();
    await request(server())
      .put(`${posts()}/bookmark`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    expect(await count('post_bookmarks')).toBe(0);
  });

  it('removes a saved post even after the post was unpublished', async () => {
    await request(server())
      .put(`${posts()}/bookmark`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    await postsModel()
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PROCESSING } })
      .exec();
    const response = await request(server())
      .delete(`${posts()}/bookmark`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toEqual({ postId: post.id, isBookmarked: false });
    expect(await count('post_bookmarks')).toBe(0);
  });

  it('lists only the caller’s saved posts and needs a session', async () => {
    await request(server()).get('/api/v1/posts/bookmarks').expect(401);
    await request(server())
      .put(`${posts()}/bookmark`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const response = await request(server())
      .get('/api/v1/posts/bookmarks')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({
      items: [{ id: post.id, isBookmarked: true }],
      nextCursor: null,
    });
    const others = await request(server())
      .get('/api/v1/posts/bookmarks')
      .auth(otherToken, { type: 'bearer' })
      .expect(200);
    expect((others.body as PostPageDto).items).toEqual([]);
  });

  it('returns personalized counts for the authenticated feed and post detail', async () => {
    await addComment(other.id);
    for (const liker of [token, otherToken]) {
      await request(server())
        .put(`${posts()}/like`)
        .auth(liker, { type: 'bearer' })
        .expect(200);
    }
    const feed = await request(server())
      .get('/api/v1/posts')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((feed.body as PostPageDto).items[0]).toMatchObject({
      commentCount: 2,
      likeCount: 2,
      isLiked: true,
    });
    const detail = await request(server())
      .get(posts())
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(detail.body).toMatchObject({
      commentCount: 2,
      likeCount: 2,
      isLiked: true,
    });
  });

  it('keeps the feed public with isLiked=false for anonymous viewers', async () => {
    await request(server())
      .put(`${posts()}/like`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const response = await request(server()).get('/api/v1/posts').expect(200);
    expect((response.body as PostPageDto).items[0]).toMatchObject({
      likeCount: 1,
      isLiked: false,
    });
  });

  it.each(['Bearer invalid', 'Basic invalid'])(
    'rejects a supplied invalid token on the public feed: %s',
    async (authorization) => {
      await request(server())
        .get('/api/v1/posts')
        .set('Authorization', authorization)
        .expect(401);
    },
  );

  it('rejects a token for a deleted account', async () => {
    const gone = await createUser(e2e.mongo);
    const goneToken = await e2e.sign(gone);
    await usersModel().deleteOne({ _id: gone.id }).exec();
    await request(server())
      .get('/api/v1/posts')
      .auth(goneToken, { type: 'bearer' })
      .expect(401);
  });

  it('validates UUID paths before querying posts', async () => {
    await request(server()).get('/api/v1/posts/invalid/comments').expect(400);
  });

  it('documents comment pagination and interaction response schemas', () => {
    const document = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder().build(),
    );
    expect(document.paths['/api/v1/posts'].get?.security).toEqual([
      {},
      { bearer: [] },
    ]);
    expect(
      document.paths['/api/v1/posts/{postId}/like'].put?.responses['200'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PostLikeResponseDto' },
        },
      },
    });
    expect(document.components?.schemas?.CommentPageDto).toMatchObject({
      properties: {
        items: { items: { $ref: '#/components/schemas/CommentResponseDto' } },
        nextCursor: { nullable: true },
      },
    });
    expect(document.components?.schemas?.PostResponseDto).toMatchObject({
      properties: { likeCount: {}, commentCount: {}, isLiked: {} },
    });
  });
});
