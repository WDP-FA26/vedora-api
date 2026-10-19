import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostStatus, PostType, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PostSearchIndexService } from '../src/post-search/post-search-index.service';
import { PostSearchService } from '../src/post-search/post-search.service';
import { PrismaService } from '../src/prisma/prisma.service';

const ADMIN_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const AUTHOR_ID = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const POST_ID = 'f1a2d3e4-0000-4000-8000-000000000001';
const now = new Date('2026-10-07T08:00:00.000Z');
const post = {
  id: POST_ID,
  type: PostType.POST,
  status: PostStatus.PROCESSING,
  authorId: AUTHOR_ID,
  body: 'Đậu hũ sốt cà',
  author: {
    id: AUTHOR_ID,
    username: 'vedora.chef',
    fullName: 'Vedora Chef',
    avatarUrl: null,
  },
  media: [],
  publishedAt: null,
  createdAt: now,
  updatedAt: now,
  viewCount: 7,
  searchIndexedAt: null,
  reposts: [],
  bookmarks: [],
  _count: { comments: 0, likes: 0, reposts: 1 },
};

describe('Post reads and admin posts (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  const postSearch = mockDeep<PostSearchService>();
  const searchIndex = mockDeep<PostSearchIndexService>();
  let app: INestApplication<App>;
  let token: string;

  function signInAs(role: UserRole) {
    prisma.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      accountVersion: 0,
      id: ADMIN_ID,
      username: 'vedora.admin',
      role,
    } as never);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(PostSearchService)
      .useValue(postSearch)
      .overrideProvider(PostSearchIndexService)
      .useValue(searchIndex)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: ADMIN_ID,
      username: 'vedora.admin',
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    mockReset(postSearch);
    mockReset(searchIndex);
    signInAs(UserRole.ADMIN);
    prisma.$transaction.mockImplementation((run: unknown) =>
      Promise.all(run as Promise<unknown>[]),
    );
    prisma.post.findMany.mockResolvedValue([post]);
    prisma.post.count.mockResolvedValue(1);
    prisma.post.findUnique.mockResolvedValue(post);
    prisma.mediaAsset.findMany.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', ''],
    ['get', `/${POST_ID}`],
    ['delete', `/${POST_ID}`],
  ] as const)('keeps %s /admin/posts%s to admins', async (method, path) => {
    await request(app.getHttpServer())
      [method](`/api/v1/admin/posts${path}`)
      .expect(401);

    signInAs(UserRole.USER);
    await request(app.getHttpServer())
      [method](`/api/v1/admin/posts${path}`)
      .auth(token, { type: 'bearer' })
      .expect(403);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it('lists posts that are not published', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/posts?limit=50')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({
      items: [{ id: POST_ID, status: PostStatus.PROCESSING }],
      meta: { totalItems: 1, limit: 50 },
    });
  });

  it("deletes another user's post", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/posts/${POST_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: POST_ID } });
    expect(searchIndex.remove).toHaveBeenCalledWith(POST_ID);
  });

  it('limits a post body to 250 words', async () => {
    const words = (count: number) => Array(count).fill('rau').join(' ');
    const response = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .auth(token, { type: 'bearer' })
      .send({ type: PostType.POST, body: words(251) })
      .expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'body must be at most 250 words',
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('searches published posts in match order for guests', async () => {
    const OTHER_ID = 'f1a2d3e4-0000-4000-8000-000000000002';
    const published = { ...post, status: PostStatus.PUBLISHED, likes: [] };
    postSearch.search.mockResolvedValue({
      ids: [OTHER_ID, POST_ID],
      hasMore: true,
    });
    postSearch.prune.mockResolvedValue();
    // OTHER_ID was deleted after it was indexed.
    prisma.post.findMany.mockResolvedValue([published] as never);

    const response = await request(app.getHttpServer())
      .get('/api/v1/posts/search')
      .query({ q: '  dau hu  ', limit: 2, cursor: 4 })
      .expect(200);

    expect(postSearch.search).toHaveBeenCalledWith('dau hu', 4, 2);
    expect(response.body).toMatchObject({
      items: [{ id: POST_ID }],
      nextCursor: '6',
    });
    expect(postSearch.prune).toHaveBeenCalledWith([OTHER_ID]);
  });

  it('rejects an empty search or one past the search depth', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/posts/search')
      .query({ q: '   ' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/posts/search')
      .query({ q: 'phở', cursor: 201 })
      .expect(400);
    expect(postSearch.search).not.toHaveBeenCalled();
  });

  it('lets guests read a published post but not one still processing', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}`)
      .expect(404);

    prisma.post.findUnique.mockResolvedValue({
      ...post,
      status: PostStatus.PUBLISHED,
      publishedAt: now,
      likes: [],
    } as never);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/posts/${POST_ID}`)
      .expect(200);
    expect(response.body).toMatchObject({ id: POST_ID, isLiked: false });
  });

  it('accepts view batches from guests without touching the database', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/posts/views')
      .send({ postIds: [POST_ID] })
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/posts/views')
      .send({ postIds: ['not-a-uuid'] })
      .expect(400);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });

  it('reposts idempotently and requires login', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/posts/${POST_ID}/repost`)
      .expect(401);

    prisma.$transaction.mockImplementation(((run: unknown) =>
      (run as (tx: unknown) => unknown)(prisma)) as never);
    prisma.post.findFirst.mockResolvedValue(post);
    prisma.postRepost.createMany.mockResolvedValue({ count: 0 });
    prisma.postRepost.count.mockResolvedValue(1);
    const response = await request(app.getHttpServer())
      .put(`/api/v1/posts/${POST_ID}/repost`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toEqual({
      postId: POST_ID,
      isReposted: true,
      repostCount: 1,
    });
    expect(prisma.postRepost.createMany).toHaveBeenCalledWith({
      data: [{ postId: POST_ID, userId: ADMIN_ID }],
      skipDuplicates: true,
    });
  });

  it('validates reports and keeps the report queue to admins', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${POST_ID}/report`)
      .auth(token, { type: 'bearer' })
      .send({ reason: 'BORING' })
      .expect(400);

    prisma.post.findFirst.mockResolvedValue(post);
    prisma.postReport.create.mockResolvedValue({ id: POST_ID } as never);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${POST_ID}/report`)
      .auth(token, { type: 'bearer' })
      .send({ reason: 'SPAM', details: '  quảng cáo  ' })
      .expect(201);
    expect(prisma.postReport.create.mock.calls[0][0].data).toMatchObject({
      reason: 'SPAM',
      details: 'quảng cáo',
    });

    signInAs(UserRole.USER);
    await request(app.getHttpServer())
      .get('/api/v1/admin/reports')
      .auth(token, { type: 'bearer' })
      .expect(403);
  });

  it('answers 404 when deleting an unknown post', async () => {
    prisma.post.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/posts/${POST_ID}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
  });
});
