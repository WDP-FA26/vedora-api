import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostStatus, PostType, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { BlogDetailDto, MAX_BLOG_CONTENT } from '../src/posts/dto/blog.dto';
import { MediaService } from '../src/media/media.service';

const AUTHOR_ID = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const BLOG_ID = 'f1a2d3e4-0000-4000-8000-000000000001';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const now = new Date('2026-10-12T08:00:00Z');
const row = {
  id: BLOG_ID,
  authorId: AUTHOR_ID,
  type: PostType.BLOG,
  status: PostStatus.DRAFT,
  body: null,
  publishedAt: null,
  createdAt: now,
  updatedAt: now,
  viewCount: 0,
  searchIndexedAt: null,
  author: {
    id: AUTHOR_ID,
    username: 'chef',
    fullName: 'Chef',
    avatarUrl: null,
  },
  blog: {
    title: 'Đậu hũ sốt cà',
    content: '## Cách làm\nNấu đậu hũ với cà chua.',
    excerpt: '## Cách làm Nấu đậu hũ với cà chua.',
    coverImageUrl: null,
    updatedAt: now,
    recipes: [{ recipe: { id: RECIPE_ID, title: 'Đậu hũ', imageUrl: null } }],
  },
  media: [],
  likes: [],
  reposts: [],
  bookmarks: [],
  _count: { comments: 0, likes: 0, reposts: 0 },
};

describe('Blogs (HTTP)', () => {
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
    token = await app
      .get(JwtService)
      .signAsync({ sub: AUTHOR_ID, username: 'chef' });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      accountVersion: 0,
      id: AUTHOR_ID,
      username: 'chef',
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation((run: unknown) =>
      typeof run === 'function'
        ? (run as (tx: PrismaService) => Promise<unknown>)(prisma)
        : Promise.all(run as Promise<unknown>[]),
    );
    prisma.post.findUnique.mockResolvedValue(row);
    prisma.post.findUniqueOrThrow.mockResolvedValue(row);
    prisma.post.create.mockResolvedValue(row);
    prisma.post.update.mockResolvedValue(row);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([{ id: BLOG_ID }]);
    prisma.recipe.findMany.mockResolvedValue([{ id: RECIPE_ID }] as never);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['post', 'patch', 'delete'] as const)(
    'requires login to %s a blog',
    async (method) => {
      await request(app.getHttpServer())
        [method](`/api/v1/blogs${method === 'post' ? '' : `/${BLOG_ID}`}`)
        .send({ title: 'Món chay' })
        .expect(401);
      expect(prisma.post.create).not.toHaveBeenCalled();
      expect(prisma.post.update).not.toHaveBeenCalled();
      expect(prisma.post.delete).not.toHaveBeenCalled();
    },
  );

  it('creates a trimmed title and defaults to a private draft', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/blogs')
      .auth(token, { type: 'bearer' })
      .send({ title: '  Đậu hũ sốt cà  ' })
      .expect(201);
    expect(response.body).toMatchObject({
      id: BLOG_ID,
      status: 'DRAFT',
      blog: { title: row.blog.title },
    });
    expect(prisma.post.create.mock.calls[0][0].data).toMatchObject({
      authorId: AUTHOR_ID,
      type: 'BLOG',
      status: 'DRAFT',
      publishedAt: null,
      blog: { create: { title: row.blog.title, content: '', excerpt: '' } },
    });
  });

  it.each([
    { title: '' },
    { title: '   ' },
    { title: null },
    { title: 'a'.repeat(151) },
    { content: null },
    { content: 'a'.repeat(MAX_BLOG_CONTENT + 1) },
    { status: 'PROCESSING' },
    { status: null },
    { recipeIds: null },
    { recipeIds: [RECIPE_ID, RECIPE_ID] },
    { recipeIds: ['bad'] },
    { coverImageUrl: 'http://example.com/a.jpg' },
    { authorId: AUTHOR_ID },
  ])('rejects invalid blog fields: %j', async (fields) => {
    await request(app.getHttpServer())
      .post('/api/v1/blogs')
      .auth(token, { type: 'bearer' })
      .send({ title: 'Món chay', ...fields })
      .expect(400);
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it('rejects publishing without content and reports missing recipes', async () => {
    const empty = await request(app.getHttpServer())
      .post('/api/v1/blogs')
      .auth(token, { type: 'bearer' })
      .send({ title: 'Món', status: 'PUBLISHED', content: '  ' })
      .expect(400);
    expect((empty.body as { code: string }).code).toBe('BLOG_CONTENT_REQUIRED');
    prisma.recipe.findMany.mockResolvedValue([]);
    const missing = await request(app.getHttpServer())
      .post('/api/v1/blogs')
      .auth(token, { type: 'bearer' })
      .send({ title: 'Món', recipeIds: [RECIPE_ID] })
      .expect(400);
    expect(missing.body).toMatchObject({
      code: 'BLOG_RECIPE_NOT_FOUND',
      recipeIds: [RECIPE_ID],
    });
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it('accepts long UTF-8 articles beyond the default JSON parser size', async () => {
    const content = '菜'.repeat(MAX_BLOG_CONTENT);
    await request(app.getHttpServer())
      .post('/api/v1/blogs')
      .auth(token, { type: 'bearer' })
      .send({ title: 'Long article', content })
      .expect(201);
    expect(prisma.post.create.mock.calls[0][0].data).toMatchObject({
      blog: { create: { content } },
    });
  });

  it('preserves the exact request bytes for signed Cloudinary notifications', async () => {
    const handle = vi
      .spyOn(app.get(MediaService), 'handleNotification')
      .mockResolvedValue();
    const payload = '{ "notification_type": "eager",  "public_id": "x" }';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHash('sha1')
      .update(payload + timestamp + 'e2e-api-secret')
      .digest('hex');
    try {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/cloudinary')
        .set('Content-Type', 'application/json')
        .set('x-cld-timestamp', timestamp)
        .set('x-cld-signature', signature)
        .send(payload)
        .expect(204);
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ notification_type: 'eager' }),
      );
    } finally {
      handle.mockRestore();
    }
  });

  it('hides drafts from guests and other users on both detail routes', async () => {
    for (const path of ['blogs', 'posts']) {
      await request(app.getHttpServer())
        .get(`/api/v1/${path}/${BLOG_ID}`)
        .expect(404);
      prisma.post.findUnique.mockResolvedValue({
        ...row,
        authorId: RECIPE_ID,
      });
      await request(app.getHttpServer())
        .get(`/api/v1/${path}/${BLOG_ID}`)
        .auth(token, { type: 'bearer' })
        .expect(404);
      prisma.post.findUnique.mockResolvedValue(row);
    }
  });

  it('lets the author read draft source without shared caching', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      content: row.blog.content,
      blog: { recipes: [{ id: RECIPE_ID }] },
    });
    expect(response.body).not.toHaveProperty('authorId');
    expect((response.body as BlogDetailDto).blog).not.toHaveProperty('content');
  });

  it('serves published source publicly and rejects invalid supplied tokens', async () => {
    prisma.post.findUnique.mockResolvedValue({
      ...row,
      status: PostStatus.PUBLISHED,
    });
    await request(app.getHttpServer())
      .get(`/api/v1/blogs/${BLOG_ID}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/blogs/${BLOG_ID}`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(app.getHttpServer()).get('/api/v1/blogs/bad-id').expect(400);
    prisma.post.findUnique.mockResolvedValue({
      ...row,
      type: PostType.POST,
      blog: null,
    } as never);
    await request(app.getHttpServer())
      .get(`/api/v1/blogs/${BLOG_ID}`)
      .expect(404);
  });

  it('limits public lists to published blogs and allows a feed type filter', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/blogs?authorId=${AUTHOR_ID}`)
      .expect(200);
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { status: 'PUBLISHED', type: 'BLOG', authorId: AUTHOR_ID },
      }),
    );
    await request(app.getHttpServer())
      .get('/api/v1/posts?type=BLOG')
      .expect(200);
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { status: 'PUBLISHED', type: 'BLOG' },
      }),
    );
    await request(app.getHttpServer())
      .get('/api/v1/posts?type=INVALID')
      .expect(400);
  });

  it('lists only the caller drafts and validates draft-list cursors', async () => {
    await request(app.getHttpServer()).get('/api/v1/blogs/mine').expect(401);
    const response = await request(app.getHttpServer())
      .get('/api/v1/blogs/mine?status=DRAFT')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { authorId: AUTHOR_ID, type: 'BLOG', status: 'DRAFT' },
      }),
    );
    prisma.post.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/api/v1/blogs/mine?cursor=${RECIPE_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(400);
  });

  it('supports partial edit, clearing a cover and replacing recipe links', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .send({ coverImageUrl: null, recipeIds: [] })
      .expect(200);
    expect(prisma.post.update.mock.calls[0][0].data).toMatchObject({
      status: 'DRAFT',
      blog: {
        update: {
          coverImageUrl: null,
          recipes: { deleteMany: {}, create: [] },
        },
      },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .send({ content: null })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(400);
  });

  it('publishes a draft and prevents another author from editing or deleting it', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .send({ status: 'PUBLISHED' })
      .expect(200);
    expect(prisma.post.update.mock.calls[0][0].data.status).toBe('PUBLISHED');
    expect(prisma.post.update.mock.calls[0][0].data.publishedAt).toBeInstanceOf(
      Date,
    );
    prisma.$queryRaw.mockResolvedValue([]);
    await request(app.getHttpServer())
      .patch(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .send({ title: 'Other' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/blogs/${BLOG_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it('blocks draft comments, likes and bookmarks through existing endpoints', async () => {
    prisma.post.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${BLOG_ID}/comments`)
      .auth(token, { type: 'bearer' })
      .send({ body: 'Ngon!' })
      .expect(404);
    for (const interaction of ['like', 'bookmark']) {
      await request(app.getHttpServer())
        .put(`/api/v1/posts/${BLOG_ID}/${interaction}`)
        .auth(token, { type: 'bearer' })
        .expect(404);
    }
    expect(prisma.postComment.create).not.toHaveBeenCalled();
    expect(prisma.postLike.createMany).not.toHaveBeenCalled();
    expect(prisma.postBookmark.createMany).not.toHaveBeenCalled();
  });
});
