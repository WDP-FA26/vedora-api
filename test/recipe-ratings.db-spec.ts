import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecipeRatingsController } from '../src/recipes/recipe-ratings.controller';
import { RecipeRatingsService } from '../src/recipes/recipe-ratings.service';
import type { MyRecipeRatingDto } from '../src/recipes/dto/recipe-rating.dto';

describe('Recipe ratings with PostgreSQL', () => {
  const schema = `vedora_ratings_test_${randomUUID().replaceAll('-', '')}`;
  const recipeId = randomUUID();
  const root = `/api/v1/recipes/${recipeId}`;
  const ids = {
    author: randomUUID(),
    first: randomUUID(),
    second: randomUUID(),
    pending: randomUUID(),
  };
  const tokens: Record<keyof typeof ids, string> = {
    author: '',
    first: '',
    second: '',
    pending: '',
  };
  let prisma: PrismaClient;
  let app: INestApplication<App>;

  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: 'recipe-ratings-database-test-secret' }),
      ],
      controllers: [RecipeRatingsController],
      providers: [
        RecipeRatingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      await prisma.user.create({
        data: {
          id: ids[name],
          username: `ratings.${name}`,
          fullName: name,
          email: `${name}@ratings.test`,
          role: name === 'author' ? UserRole.ADMIN : UserRole.USER,
          emailVerifiedAt: name === 'pending' ? null : new Date(),
        },
      });
      tokens[name] = await app
        .get(JwtService)
        .signAsync({ sub: ids[name], username: `ratings.${name}` });
    }
  });

  beforeEach(async () => {
    await prisma.recipeRating.deleteMany();
    await prisma.user.updateMany({
      where: { id: { in: [ids.author, ids.first, ids.second] } },
      data: { emailVerifiedAt: new Date() },
    });
    const data = {
      title: 'Đậu hũ sốt cà',
      servings: 2,
      steps: ['Nấu'],
      createdById: ids.author,
    };
    await prisma.recipe.upsert({
      where: { id: recipeId },
      create: { id: recipeId, ...data },
      update: data,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.$executeRaw(
        Prisma.sql`DROP SCHEMA ${Prisma.raw(`"${schema}"`)} CASCADE`,
      );
      await prisma.$disconnect();
    }
  });

  const put = (value: number, token = tokens.first) =>
    request(app.getHttpServer())
      .put(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value });
  const remove = (token = tokens.first) =>
    request(app.getHttpServer())
      .delete(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`);
  const summary = () =>
    request(app.getHttpServer()).get(`${root}/ratings/summary`);
  const mine = (token: string) =>
    request(app.getHttpServer())
      .get(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`);

  it('creates, updates and retries one score without inflating the count', async () => {
    expect((await put(4).expect(200)).body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 4,
      myRating: 4,
    });
    await put(5).expect(200);
    const retried = await put(5).expect(200);
    expect(retried.body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 5,
      myRating: 5,
    });
    expect(await prisma.recipeRating.count()).toBe(1);
  });

  it('computes the mean from multiple members and rounds to one decimal', async () => {
    await put(4).expect(200);
    await put(5, tokens.second).expect(200);
    const extra = await prisma.user.create({
      data: {
        username: 'ratings.third',
        fullName: 'Third',
        email: 'third@ratings.test',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.recipeRating.create({
      data: { recipeId, userId: extra.id, value: 5 },
    });
    const response = await summary().expect(200);
    expect(response.body).toEqual({
      recipeId,
      ratingCount: 3,
      averageRating: 4.7,
    });
    await prisma.user.delete({ where: { id: extra.id } });
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 4.5,
    });
  });

  it('keeps each member score private, including when the caller is an admin', async () => {
    await put(2).expect(200);
    await put(5, tokens.second).expect(200);
    expect((await mine(tokens.first).expect(200)).body).toMatchObject({
      myRating: 2,
      ratingCount: 2,
      averageRating: 3.5,
    });
    expect((await mine(tokens.second).expect(200)).body).toMatchObject({
      myRating: 5,
    });
    expect((await mine(tokens.author).expect(200)).body).toMatchObject({
      myRating: null,
    });
    // A supplied query identity does not change the authenticated owner.
    const response = await request(app.getHttpServer())
      .get(`${root}/rating?userId=${ids.second}`)
      .set('Authorization', `Bearer ${tokens.first}`)
      .expect(200);
    expect(response.body).toMatchObject({ myRating: 2 });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 3.5,
    });
  });

  it('rejects an author self-rating even with ADMIN role', async () => {
    const response = await put(5, tokens.author).expect(403);
    expect(response.body).toMatchObject({ code: 'SELF_RATING_NOT_ALLOWED' });
    expect(await prisma.recipeRating.count()).toBe(0);
  });

  it('deletes only the caller score and allows repeated deletion', async () => {
    await put(1).expect(200);
    await put(5, tokens.second).expect(200);
    await remove().expect(200);
    const repeated = await remove().expect(200);
    expect(repeated.body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 5,
      myRating: null,
    });
    expect((await mine(tokens.second).expect(200)).body).toMatchObject({
      myRating: 5,
    });
    await remove(tokens.second).expect(200);
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 0,
      averageRating: null,
    });
  });

  it('does not admit an unverified account or count its existing score', async () => {
    await put(5, tokens.pending).expect(403);
    await put(2).expect(200);
    await put(5, tokens.second).expect(200);
    await prisma.user.update({
      where: { id: ids.second },
      data: { emailVerifiedAt: null },
    });
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 2,
    });
    await put(4, tokens.second).expect(403);
    await prisma.user.update({
      where: { id: ids.second },
      data: { emailVerifiedAt: new Date() },
    });
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 3.5,
    });
    expect(await prisma.recipeRating.count()).toBe(2);
  });

  it('handles 20 concurrent retries for one member as one rating', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => put(4)),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(200));
    expect(await prisma.recipeRating.count()).toBe(1);
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 4,
    });
  });

  it('serializes concurrent updates/deletes and returns an aggregate matching every write', async () => {
    const responses = await Promise.all([put(1), put(5), remove(), put(3)]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    for (const [index, value] of [1, 5, null, 3].entries()) {
      expect(responses[index].body).toEqual({
        recipeId,
        ratingCount: value === null ? 0 : 1,
        averageRating: value,
        myRating: value,
      });
    }
    const records = await prisma.recipeRating.findMany();
    const final = (await summary().expect(200)).body as MyRecipeRatingDto;
    expect(final.ratingCount).toBe(records.length);
    expect(final.averageRating).toBe(records[0]?.value ?? null);
  });

  it('keeps separate records when different members rate concurrently', async () => {
    const responses = await Promise.all([put(2), put(5, tokens.second)]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(await prisma.recipeRating.count()).toBe(2);
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 3.5,
    });
  });

  it.each([0, 6])('enforces the database CHECK for score %s', async (value) => {
    await expect(
      prisma.recipeRating.create({
        data: { recipeId, userId: ids.first, value },
      }),
    ).rejects.toThrow();
    expect(await prisma.recipeRating.count()).toBe(0);
  });

  it('enforces unique member/recipe pairs and missing recipe references in the database', async () => {
    await put(4).expect(200);
    await expect(
      prisma.recipeRating.create({
        data: { recipeId, userId: ids.first, value: 5 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.recipeRating.create({
        data: { recipeId: randomUUID(), userId: ids.second, value: 5 },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.recipeRating.count()).toBe(1);
  });

  it('does not recreate ratings or summaries after recipe deletion, including a concurrent PUT', async () => {
    await put(4).expect(200);
    const [response] = await Promise.all([
      put(5),
      prisma.recipe.delete({ where: { id: recipeId } }),
    ]);
    expect([200, 404, 409]).toContain(response.status);
    expect(await prisma.recipeRating.count()).toBe(0);
    await summary().expect(404);
    await put(3).expect(404);
    await remove().expect(404);
  });
});
