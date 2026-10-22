import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const ROOT = `/api/v1/recipes/${RECIPE_ID}/favorite`;

describe('Recipe favorites (e2e)', () => {
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
      .signAsync({ sub: USER_ID, username: 'favorites.user' });
  });
  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: 'favorites.user',
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
    prisma.recipeFavorite.findMany.mockResolvedValue([]);
    prisma.recipeFavorite.count.mockResolvedValue(0);
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['put', ROOT],
    ['delete', ROOT],
    ['get', '/api/v1/recipes/favorites'],
  ] as const)('requires auth for %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });
  it.each(['put', 'delete'] as const)(
    'handles %s without client identity and returns a private state',
    async (method) => {
      const response = await request(app.getHttpServer())
        [method](ROOT)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(response.body).toEqual({
        recipeId: RECIPE_ID,
        isFavorite: method === 'put',
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
    },
  );
  it.each(['put', 'delete'] as const)(
    'rejects a client userId on %s',
    async (method) => {
      await request(app.getHttpServer())
        [method](ROOT)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: USER_ID })
        .expect(400);
      expect(prisma.recipeFavorite.createMany).not.toHaveBeenCalled();
      expect(prisma.recipeFavorite.deleteMany).not.toHaveBeenCalled();
    },
  );
  it.each(['userId=other', 'page=0', 'limit=51', 'sort=title'])(
    'rejects unsupported favorite query %s',
    async (query) => {
      await request(app.getHttpServer())
        .get(`/api/v1/recipes/favorites?${query}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    },
  );
  it('routes favorites before :id and returns page metadata for an empty private list', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/recipes/favorites')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toMatchObject({
      items: [],
      meta: { page: 1, totalItems: 0 },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['put', 'delete'] as const)(
    'returns 404 on %s for a missing recipe',
    async (method) => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: USER_ID }])
        .mockResolvedValueOnce([]);
      await request(app.getHttpServer())
        [method](ROOT)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    },
  );
});
