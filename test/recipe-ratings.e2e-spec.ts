import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const AUTHOR_ID = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const ROOT = `/api/v1/recipes/${RECIPE_ID}`;

describe('Recipe ratings API (e2e)', () => {
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
      .signAsync({ sub: USER_ID, username: 'rater' });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: 'rater',
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    // Each write locks actor, then recipe.
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: USER_ID, emailVerifiedAt: new Date() }])
      .mockResolvedValue([{ id: RECIPE_ID, createdById: AUTHOR_ID }]);
    prisma.recipe.findUnique.mockResolvedValue({ id: RECIPE_ID } as never);
    prisma.recipeRating.aggregate.mockResolvedValue({
      _count: { value: 1 },
      _sum: { value: 4 },
    } as never);
    prisma.recipeRating.findUnique.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes only the count and mean, without requiring login', async () => {
    const response = await request(app.getHttpServer())
      .get(`${ROOT}/ratings/summary`)
      .expect(200);
    expect(response.body).toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 1,
      averageRating: 4,
    });
  });

  it('rejects an invalid token even on the public summary endpoint', async () => {
    await request(app.getHttpServer())
      .get(`${ROOT}/ratings/summary`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
  });

  it.each(['get', 'put', 'delete'] as const)(
    'requires login for %s own rating',
    async (method) => {
      await request(app.getHttpServer())
        [method](`${ROOT}/rating`)
        .send({ value: 4 })
        .expect(401);
      expect(prisma.recipeRating.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([0, 6, -1, 4.5, '4', null, true])(
    'rejects an invalid rating value: %s',
    async (value) => {
      await request(app.getHttpServer())
        .put(`${ROOT}/rating`)
        .set('Authorization', `Bearer ${token}`)
        .send({ value })
        .expect(400);
      expect(prisma.recipeRating.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { value: 4, userId: AUTHOR_ID },
    { value: 4, ratingCount: 100 },
    { value: 4, averageRating: 5 },
  ])(
    'rejects missing score or client-controlled identity/aggregate: %j',
    async (body) => {
      await request(app.getHttpServer())
        .put(`${ROOT}/rating`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      expect(prisma.recipeRating.upsert).not.toHaveBeenCalled();
    },
  );

  it('returns the authenticated caller score with private cache headers', async () => {
    prisma.recipeRating.findUnique.mockResolvedValue({ value: 4 } as never);
    const response = await request(app.getHttpServer())
      .get(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 1,
      averageRating: 4,
      myRating: 4,
    });
  });

  it('stores an authenticated score and returns the resulting summary', async () => {
    const response = await request(app.getHttpServer())
      .put(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 4 })
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      ratingCount: 1,
      averageRating: 4,
      myRating: 4,
    });
  });

  it('rejects self-rating', async () => {
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: USER_ID, emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: RECIPE_ID, createdById: USER_ID }]);
    const response = await request(app.getHttpServer())
      .put(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 5 })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'SELF_RATING_NOT_ALLOWED' });
    expect(prisma.recipeRating.upsert).not.toHaveBeenCalled();
  });

  it('does not let a token bypass unverified email', async () => {
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: USER_ID, emailVerifiedAt: null }]);
    const response = await request(app.getHttpServer())
      .put(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 5 })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('deletes a score without returning voter data', async () => {
    prisma.recipeRating.aggregate.mockResolvedValue({
      _count: { value: 0 },
      _sum: { value: null },
    } as never);
    const response = await request(app.getHttpServer())
      .delete(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 0,
      averageRating: null,
      myRating: null,
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('returns 404 for a missing recipe instead of an empty summary', async () => {
    prisma.recipe.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`${ROOT}/ratings/summary`)
      .expect(404);
  });

  it('returns a reloadable conflict when a database write is aborted', async () => {
    prisma.recipeRating.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: '6.12.0',
      }),
    );
    const response = await request(app.getHttpServer())
      .put(`${ROOT}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 4 })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'RATING_CONFLICT' });
  });

  it('rejects malformed recipe IDs', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/recipes/not-a-uuid/ratings/summary')
      .expect(400);
  });

  it('documents the rating endpoints and body in OpenAPI', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(doc.paths['/api/v1/recipes/{recipeId}/rating']).toHaveProperty(
      'put',
    );
    expect(
      doc.paths['/api/v1/recipes/{recipeId}/ratings/summary'],
    ).toHaveProperty('get');
    expect(doc.components?.schemas?.SetRecipeRatingDto).toMatchObject({
      required: ['value'],
      properties: { value: { type: 'integer', minimum: 1, maximum: 5 } },
    });
  });
});
