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
import { MAX_PAGE_NUMBER } from '../src/common/pagination';
import { PrismaService } from '../src/prisma/prisma.service';

const AUTHOR_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const postIds = [
  'f1a2d3e4-0000-4000-8000-000000000003',
  'f1a2d3e4-0000-4000-8000-000000000002',
  'f1a2d3e4-0000-4000-8000-000000000001',
];

describe('Shared pagination (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;
  const now = new Date();
  const user = {
    id: AUTHOR_ID,
    username: 'vedora.user',
    fullName: 'Vedora User',
    email: 'hello@vedora.vn',
    createdAt: now,
    updatedAt: now,
  };
  const posts = postIds.map((id) => ({
    id,
    type: PostType.POST,
    status: PostStatus.PUBLISHED,
    body: id,
    authorId: AUTHOR_ID,
    author: {
      id: AUTHOR_ID,
      username: user.username,
      fullName: user.fullName,
      avatarUrl: null,
    },
    media: [],
    viewCount: 7,
    reposts: [],
    bookmarks: [],
    _count: { comments: 0, likes: 0, reposts: 1 },
    likes: [],
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: AUTHOR_ID,
      username: user.username,
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: AUTHOR_ID,
      username: user.username,
      role: UserRole.ADMIN,
    } as never);
    prisma.$transaction.mockResolvedValue([[user], 23]);
    prisma.post.findMany.mockResolvedValue(posts);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/users', () => {
    it('still requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/users').expect(401);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns a bounded first page by default', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        items: [{ id: AUTHOR_ID }],
        meta: {
          page: 1,
          limit: 20,
          totalItems: 23,
          totalPages: 2,
          hasNextPage: true,
          hasPreviousPage: false,
        },
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      );
    });

    it('transforms page/limit strings and reads a consistent count and slice', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/users?page=2&limit=10')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        meta: {
          page: 2,
          limit: 10,
          totalPages: 3,
          hasPreviousPage: true,
          hasNextPage: true,
        },
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(prisma.user.count).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });

    it.each([1, 50])('accepts the limit boundary %i', async (limit) => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/users?limit=${limit}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({ meta: { limit } });
    });

    it('returns an empty result with zero totals', async () => {
      prisma.$transaction.mockResolvedValue([[], 0]);
      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        items: [],
        meta: {
          totalItems: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    });

    it('returns an empty out-of-range page with the actual total', async () => {
      prisma.$transaction.mockResolvedValue([[], 23]);
      const response = await request(app.getHttpServer())
        .get('/api/v1/users?page=4&limit=10')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        items: [],
        meta: { page: 4, totalItems: 23, totalPages: 3, hasNextPage: false },
      });
    });

    it.each([
      'page=0',
      'page=-1',
      'page=1.5',
      'page=abc',
      'page=',
      `page=${MAX_PAGE_NUMBER + 1}`,
      'page=9007199254740992',
      'limit=0',
      'limit=-1',
      'limit=1.5',
      'limit=abc',
      'limit=',
      'limit=51',
      'limit=Infinity',
      'page=1&page=2',
      'limit=1&limit=2',
      'skip=10',
      'cursor=unexpected',
    ])(
      'rejects invalid pagination before querying the DB: %s',
      async (query) => {
        await request(app.getHttpServer())
          .get(`/api/v1/users?${query}`)
          .auth(token, { type: 'bearer' })
          .expect(400);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.user.findMany).not.toHaveBeenCalled();
        expect(prisma.user.count).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /api/v1/posts', () => {
    it('preserves the existing cursor response and excludes the lookahead row', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/posts?limit=2')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        items: [{ id: postIds[0] }, { id: postIds[1] }],
        nextCursor: postIds[1],
      });
      expect(response.body).not.toHaveProperty('meta');
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3 }),
      );
    });

    it('keeps the author filter and skips the cursor record on the next page', async () => {
      prisma.post.findMany.mockResolvedValue([posts[2]]);
      const response = await request(app.getHttpServer())
        .get(`/api/v1/posts?limit=2&cursor=${postIds[1]}&authorId=${AUTHOR_ID}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toMatchObject({
        items: [{ id: postIds[2] }],
        nextCursor: null,
      });
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: postIds[1] },
          skip: 1,
          where: { status: PostStatus.PUBLISHED, authorId: AUTHOR_ID },
        }),
      );
    });

    it('keeps the default size of twenty', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/posts')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 21 }),
      );
    });

    it.each(['limit=0', 'limit=51', 'cursor=invalid', 'page=1'])(
      'inherits cursor validation: %s',
      async (query) => {
        await request(app.getHttpServer())
          .get(`/api/v1/posts?${query}`)
          .auth(token, { type: 'bearer' })
          .expect(400);
        expect(prisma.post.findMany).not.toHaveBeenCalled();
      },
    );
  });

  it('documents inherited query fields and concrete item schemas in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(document.paths['/api/v1/users'].get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query' }),
        expect.objectContaining({ name: 'limit', in: 'query' }),
      ]),
    );
    expect(document.paths['/api/v1/users'].get?.responses['200']).toMatchObject(
      {
        content: {
          'application/json': {
            schema: {
              allOf: [
                { $ref: '#/components/schemas/PaginatedResponseDto' },
                {
                  properties: {
                    items: {
                      items: { $ref: '#/components/schemas/UserResponseDto' },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    );
    expect(document.components?.schemas?.PostPageDto).toMatchObject({
      properties: {
        items: { items: { $ref: '#/components/schemas/PostResponseDto' } },
        nextCursor: { nullable: true },
      },
    });
  });
});
