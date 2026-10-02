import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PostStatus, PostType, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { CommentPageDto } from '../src/posts/dto/comment.dto';
import type { PostPageDto } from '../src/posts/dto/post-response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const OTHER_ID = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const POST_ID = 'f1a2d3e4-0000-4000-8000-000000000001';
const COMMENT_ID = 'f1a2d3e4-0000-4000-8000-000000000002';
const SECOND_COMMENT_ID = 'f1a2d3e4-0000-4000-8000-000000000003';
const THIRD_COMMENT_ID = 'f1a2d3e4-0000-4000-8000-000000000004';
const now = new Date('2026-10-02T08:00:00.000Z');
const author = {
  id: USER_ID,
  username: 'vedora.user',
  fullName: 'Vedora User',
  avatarUrl: null,
};
const commentResponse = {
  id: COMMENT_ID,
  postId: POST_ID,
  body: 'Bài viết hữu ích!',
  author,
  createdAt: now,
  updatedAt: now,
};
const comment = { ...commentResponse, authorId: USER_ID };
const post = {
  id: POST_ID,
  type: PostType.POST,
  status: PostStatus.PUBLISHED,
  authorId: OTHER_ID,
  body: 'Plant based cooking',
  author: { ...author, id: OTHER_ID },
  media: [],
  publishedAt: now,
  createdAt: now,
  updatedAt: now,
  _count: { comments: 2, likes: 3 },
  likes: [{ userId: USER_ID }],
};

describe('Post comments and likes (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: USER_ID,
      username: author.username,
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: author.username,
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation(async (callback) => {
      if (typeof callback !== 'function')
        throw new Error('Expected a transaction callback');
      return callback(prisma);
    });
    prisma.post.findFirst.mockResolvedValue(post);
    prisma.post.findUnique.mockResolvedValue(post);
    prisma.post.findMany.mockResolvedValue([post]);
    prisma.postComment.findFirst.mockResolvedValue(comment);
    prisma.postComment.findMany.mockResolvedValue([commentResponse] as never);
    prisma.postComment.create.mockResolvedValue(commentResponse as never);
    prisma.postComment.update.mockResolvedValue(commentResponse as never);
    prisma.postComment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.postLike.createMany.mockResolvedValue({ count: 1 });
    prisma.postLike.deleteMany.mockResolvedValue({ count: 1 });
    prisma.postLike.count.mockResolvedValue(3);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['post', `/${POST_ID}/comments`],
    ['patch', `/${POST_ID}/comments/${COMMENT_ID}`],
    ['delete', `/${POST_ID}/comments/${COMMENT_ID}`],
    ['put', `/${POST_ID}/like`],
    ['delete', `/${POST_ID}/like`],
  ] as const)('requires login for %s %s', async (method, path) => {
    await request(app.getHttpServer())
      [method](`/api/v1/posts${path}`)
      .send({ body: 'Hello' })
      .expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a comment with a trimmed body and the authenticated author', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/posts/${POST_ID}/comments`)
      .auth(token, { type: 'bearer' })
      .send({ body: '  Bài viết hữu ích!  ' })
      .expect(201);
    expect(response.body).toMatchObject({
      id: COMMENT_ID,
      body: commentResponse.body,
      author,
    });
    expect(prisma.postComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          postId: POST_ID,
          authorId: USER_ID,
          body: commentResponse.body,
        },
      }),
    );
    expect(prisma.post.findFirst).toHaveBeenCalledWith({
      where: { id: POST_ID, status: PostStatus.PUBLISHED },
      select: { id: true, authorId: true },
    });
  });

  it.each([
    {},
    { body: '' },
    { body: ' \n\t ' },
    { body: null },
    { body: 123 },
    { body: ['hello'] },
    { body: 'a'.repeat(1001) },
    { body: 'hello', authorId: OTHER_ID },
    { body: 'hello', parentId: COMMENT_ID },
  ])('rejects an invalid create/edit body: %j', async (body) => {
    for (const method of ['post', 'patch'] as const) {
      const path = method === 'post' ? 'comments' : `comments/${COMMENT_ID}`;
      await request(app.getHttpServer())
        [method](`/api/v1/posts/${POST_ID}/${path}`)
        .auth(token, { type: 'bearer' })
        .send(body)
        .expect(400);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts the maximum comment length', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${POST_ID}/comments`)
      .auth(token, { type: 'bearer' })
      .send({ body: 'a'.repeat(1000) })
      .expect(201);
    expect(prisma.postComment.create).toHaveBeenCalled();
  });

  it('allows the comment author to edit', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/posts/${POST_ID}/comments/${COMMENT_ID}`)
      .auth(token, { type: 'bearer' })
      .send({ body: 'Updated' })
      .expect(200);
    expect(prisma.postComment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COMMENT_ID, postId: POST_ID, authorId: USER_ID },
        data: { body: 'Updated' },
      }),
    );
  });

  it.each([UserRole.USER, UserRole.ADMIN])(
    'rejects editing another author’s comment as %s',
    async (role) => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        username: author.username,
        role,
      } as never);
      prisma.postComment.findFirst.mockResolvedValue({
        ...comment,
        authorId: OTHER_ID,
      });
      await request(app.getHttpServer())
        .patch(`/api/v1/posts/${POST_ID}/comments/${COMMENT_ID}`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Updated' })
        .expect(403);
      expect(prisma.postComment.update).not.toHaveBeenCalled();
    },
  );

  it.each(['comment author', 'post author', 'admin'])(
    'allows deletion by the %s',
    async (actor) => {
      if (actor !== 'comment author')
        prisma.postComment.findFirst.mockResolvedValue({
          ...comment,
          authorId: OTHER_ID,
        });
      if (actor === 'post author')
        prisma.post.findFirst.mockResolvedValue({ ...post, authorId: USER_ID });
      if (actor === 'admin')
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          username: author.username,
          role: UserRole.ADMIN,
        } as never);
      await request(app.getHttpServer())
        .delete(`/api/v1/posts/${POST_ID}/comments/${COMMENT_ID}`)
        .auth(token, { type: 'bearer' })
        .expect(204);
      expect(prisma.postComment.deleteMany).toHaveBeenCalledWith({
        where: { id: COMMENT_ID, postId: POST_ID },
      });
    },
  );

  it('rejects deletion by an unrelated account', async () => {
    prisma.postComment.findFirst.mockResolvedValue({
      ...comment,
      authorId: OTHER_ID,
    });
    await request(app.getHttpServer())
      .delete(`/api/v1/posts/${POST_ID}/comments/${COMMENT_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(403);
    expect(prisma.postComment.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['patch', 'delete'] as const)(
    'returns 404 for a missing comment or one outside the supplied post (%s)',
    async (method) => {
      prisma.postComment.findFirst.mockResolvedValue(null);
      await request(app.getHttpServer())
        [method](`/api/v1/posts/${POST_ID}/comments/${COMMENT_ID}`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Updated' })
        .expect(404);
      expect(prisma.postComment.findFirst).toHaveBeenCalledWith({
        where: { id: COMMENT_ID, postId: POST_ID },
        select: { id: true, authorId: true },
      });
      expect(prisma.postComment.update).not.toHaveBeenCalled();
      expect(prisma.postComment.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('publicly lists comments with cursor pagination and excludes the extra row', async () => {
    const rows = [
      commentResponse,
      { ...commentResponse, id: SECOND_COMMENT_ID },
      { ...commentResponse, id: THIRD_COMMENT_ID },
    ];
    prisma.postComment.findMany.mockResolvedValue(rows as never);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}/comments?limit=2`)
      .expect(200);
    const body = response.body as CommentPageDto;
    expect(body.items.map((item) => item.id)).toEqual([
      COMMENT_ID,
      SECOND_COMMENT_ID,
    ]);
    expect(body.nextCursor).toBe(SECOND_COMMENT_ID);
    expect(prisma.postComment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: POST_ID },
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('skips the cursor and returns null at the last page', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}/comments?cursor=${COMMENT_ID}&limit=2`)
      .expect(200);
    expect((response.body as CommentPageDto).nextCursor).toBeNull();
    expect(prisma.postComment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: COMMENT_ID }, skip: 1 }),
    );
  });

  it('rejects a cursor deleted or belonging to another post', async () => {
    prisma.postComment.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}/comments?cursor=${COMMENT_ID}`)
      .expect(400);
    expect(prisma.postComment.findMany).not.toHaveBeenCalled();
  });

  it.each(['limit=0', 'limit=51', 'cursor=invalid', 'page=1'])(
    'validates comment query %s',
    async (query) => {
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${POST_ID}/comments?${query}`)
        .expect(400);
      expect(prisma.post.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['get', 'comments'],
    ['post', 'comments'],
    ['patch', `comments/${COMMENT_ID}`],
    ['delete', `comments/${COMMENT_ID}`],
    ['put', 'like'],
    ['delete', 'like'],
  ] as const)(
    'hides missing/non-published posts on %s %s',
    async (method, path) => {
      prisma.post.findFirst.mockResolvedValue(null);
      await request(app.getHttpServer())
        [method](`/api/v1/posts/${POST_ID}/${path}`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Hello' })
        .expect(404);
      expect(prisma.postComment.create).not.toHaveBeenCalled();
      expect(prisma.postLike.createMany).not.toHaveBeenCalled();
    },
  );

  it('likes idempotently without creating duplicate rows', async () => {
    prisma.postLike.createMany.mockResolvedValue({ count: 0 });
    const response = await request(app.getHttpServer())
      .put(`/api/v1/posts/${POST_ID}/like`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toEqual({
      postId: POST_ID,
      isLiked: true,
      likeCount: 3,
    });
    expect(prisma.postLike.createMany).toHaveBeenCalledWith({
      data: [{ postId: POST_ID, userId: USER_ID }],
      skipDuplicates: true,
    });
  });

  it('unlikes idempotently and only removes the caller’s like', async () => {
    prisma.postLike.deleteMany.mockResolvedValue({ count: 0 });
    const response = await request(app.getHttpServer())
      .delete(`/api/v1/posts/${POST_ID}/like`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toEqual({
      postId: POST_ID,
      isLiked: false,
      likeCount: 3,
    });
    expect(prisma.postLike.deleteMany).toHaveBeenCalledWith({
      where: { postId: POST_ID, userId: USER_ID },
    });
  });

  it('returns personalized counts for the authenticated feed and post detail', async () => {
    const feed = await request(app.getHttpServer())
      .get('/api/v1/posts')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((feed.body as PostPageDto).items[0]).toMatchObject({
      commentCount: 2,
      likeCount: 3,
      isLiked: true,
    });
    expect(prisma.post.findMany.mock.calls[0][0]?.include?.likes).toMatchObject(
      {
        where: { userId: USER_ID },
      },
    );
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(detail.body).toMatchObject({
      commentCount: 2,
      likeCount: 3,
      isLiked: true,
    });
  });

  it('keeps the feed public with isLiked=false for anonymous viewers', async () => {
    const anonymousPost = { ...post, likes: [] };
    prisma.post.findMany.mockResolvedValue([anonymousPost]);
    const response = await request(app.getHttpServer())
      .get('/api/v1/posts')
      .expect(200);
    expect((response.body as PostPageDto).items[0]).toMatchObject({
      likeCount: 3,
      isLiked: false,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.post.findMany.mock.calls[0][0]?.include?.likes).toMatchObject(
      {
        where: { userId: { in: [] } },
      },
    );
  });

  it.each(['Bearer invalid', 'Basic invalid'])(
    'rejects a supplied invalid token on the public feed: %s',
    async (authorization) => {
      await request(app.getHttpServer())
        .get('/api/v1/posts')
        .set('Authorization', authorization)
        .expect(401);
      expect(prisma.post.findMany).not.toHaveBeenCalled();
    },
  );

  it('rejects a token for a deleted account', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get('/api/v1/posts')
      .auth(token, { type: 'bearer' })
      .expect(401);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it.each(['P2003', 'P2025'])(
    'maps a concurrent missing-record error (%s) to 404',
    async (code) => {
      prisma.postComment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Missing record', {
          code,
          clientVersion: '6.12.0',
        }),
      );
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${POST_ID}/comments`)
        .auth(token, { type: 'bearer' })
        .send({ body: 'Hello' })
        .expect(404);
    },
  );

  it('validates UUID paths before querying posts', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/posts/invalid/comments')
      .expect(400);
    expect(prisma.post.findFirst).not.toHaveBeenCalled();
  });

  it('documents comment pagination and interaction response schemas', () => {
    const document = SwaggerModule.createDocument(
      app,
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
