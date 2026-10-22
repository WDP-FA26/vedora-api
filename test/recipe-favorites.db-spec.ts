import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecipesController } from '../src/recipes/recipes.controller';
import { RecipeCatalogService } from '../src/recipes/recipe-catalog.service';
import { RecipeFavoritesService } from '../src/recipes/recipe-favorites.service';
import { IncompatibilityRulesService } from '../src/recipes/incompatibility-rules.service';
import type { FavoriteRecipeDto } from '../src/recipes/dto/recipe-favorite.dto';
import type { PaginatedResponseDto } from '../src/common/pagination';

describe('Recipe favorites with PostgreSQL', () => {
  const schema = `vedora_favorites_test_${randomUUID().replaceAll('-', '')}`;
  let db: PrismaClient;
  let app: INestApplication<App>;
  let first: string;
  let second: string;
  let firstToken: string;
  let secondToken: string;
  let recipes: string[];
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(process.env.TEST_DATABASE_URL);
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
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'favorites-integration-secret' })],
      controllers: [RecipesController],
      providers: [
        RecipeCatalogService,
        RecipeFavoritesService,
        IncompatibilityRulesService,
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const users = await Promise.all(
      ['first', 'second'].map((name) =>
        db.user.create({
          data: {
            username: `favorites.${name}`,
            fullName: name,
            email: `${name}@favorites.test`,
            emailVerifiedAt: new Date(),
          },
        }),
      ),
    );
    [first, second] = users.map(({ id }) => id);
    [firstToken, secondToken] = await Promise.all(
      users.map((user) =>
        app
          .get(JwtService)
          .signAsync({ sub: user.id, username: user.username }),
      ),
    );
    recipes = [];
    for (let index = 0; index < 3; index++) {
      const recipe = await db.recipe.create({
        data: { title: `Saved recipe ${index}`, servings: 2, steps: ['Cook'] },
      });
      recipes.push(recipe.id);
    }
  });
  beforeEach(async () => {
    await db.recipeFavorite.deleteMany();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.$executeRaw(
        Prisma.sql`DROP SCHEMA ${Prisma.raw(`"${schema}"`)} CASCADE`,
      );
      await db.$disconnect();
    }
  });
  const save = (id: string, token = firstToken) =>
    request(app.getHttpServer())
      .put(`/api/v1/recipes/${id}/favorite`)
      .set('Authorization', `Bearer ${token}`);
  const remove = (id: string, token = firstToken) =>
    request(app.getHttpServer())
      .delete(`/api/v1/recipes/${id}/favorite`)
      .set('Authorization', `Bearer ${token}`);
  const list = (token = firstToken, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/recipes/favorites${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('handles 20 concurrent saves as one relation and preserves the original save time on retry', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => save(recipes[0])),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(200));
    const original = await db.recipeFavorite.findUniqueOrThrow({
      where: { recipeId_userId: { recipeId: recipes[0], userId: first } },
    });
    await save(recipes[0]).expect(200);
    expect(await db.recipeFavorite.count()).toBe(1);
    expect((await db.recipeFavorite.findFirstOrThrow()).createdAt).toEqual(
      original.createdAt,
    );
  });
  it('isolates lists, personalized catalog/detail flags and cache by caller', async () => {
    await save(recipes[0]).expect(200);
    expect((await list(secondToken).expect(200)).body).toMatchObject({
      items: [],
      meta: { totalItems: 0 },
    });
    const firstList = (await list().expect(200))
      .body as PaginatedResponseDto<FavoriteRecipeDto>;
    expect(firstList.items.map(({ id }) => id)).toEqual([recipes[0]]);
    for (const [token, expected] of [
      [firstToken, true],
      [secondToken, false],
      [undefined, false],
    ] as const) {
      const req = request(app.getHttpServer()).get(
        `/api/v1/recipes/${recipes[0]}`,
      );
      if (token) req.set('Authorization', `Bearer ${token}`);
      const response = await req.expect(200);
      expect(response.body).toMatchObject({ isFavorite: expected });
      expect(String(response.headers.vary)).toContain('Authorization');
      if (token)
        expect(response.headers['cache-control']).toBe('private, no-store');
      const catalog = request(app.getHttpServer()).get('/api/v1/recipes');
      if (token) catalog.set('Authorization', `Bearer ${token}`);
      const page = (await catalog.expect(200))
        .body as PaginatedResponseDto<FavoriteRecipeDto>;
      expect(page.items.find(({ id }) => id === recipes[0])?.isFavorite).toBe(
        expected,
      );
    }
  });
  it('paginates equal savedAt timestamps using recipe ID as a stable tie breaker', async () => {
    for (const id of recipes) await save(id).expect(200);
    await db.recipeFavorite.updateMany({
      data: { createdAt: new Date('2026-10-19T00:00:00Z') },
    });
    const one = (await list(firstToken, '?limit=2').expect(200))
      .body as PaginatedResponseDto<FavoriteRecipeDto>;
    const two = (await list(firstToken, '?limit=2&page=2').expect(200))
      .body as PaginatedResponseDto<FavoriteRecipeDto>;
    expect([...one.items, ...two.items].map(({ id }) => id)).toEqual(
      [...recipes].sort().reverse(),
    );
    expect(one.meta).toMatchObject({
      totalItems: 3,
      totalPages: 2,
      hasNextPage: true,
    });
    expect(two.meta.hasNextPage).toBe(false);
    expect((await list(firstToken, '?page=99').expect(200)).body).toMatchObject(
      { items: [], meta: { totalItems: 3 } },
    );
  });
  it('removes only the caller relation, including repeated and concurrent deletes', async () => {
    await save(recipes[0]).expect(200);
    await save(recipes[0], secondToken).expect(200);
    const responses = await Promise.all([
      remove(recipes[0]),
      remove(recipes[0]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect((await list().expect(200)).body).toMatchObject({ items: [] });
    expect(await db.recipeFavorite.count({ where: { userId: second } })).toBe(
      1,
    );
  });
  it('does not leak a private source post through favorites', async () => {
    const post = await db.post.create({
      data: { authorId: first, status: 'PROCESSING', body: 'private' },
    });
    await db.recipe.update({
      where: { id: recipes[0] },
      data: { postId: post.id },
    });
    await save(recipes[0]).expect(200);
    const response = (await list().expect(200))
      .body as PaginatedResponseDto<FavoriteRecipeDto>;
    expect(response.items[0].post).toBeNull();
    expect(response.items[0]).not.toHaveProperty('createdById');
    await db.post.delete({ where: { id: post.id } });
  });
  it('rejects an injected owner and keeps all mutations on the authenticated account', async () => {
    await save(recipes[0]).send({ userId: second }).expect(400);
    await list(firstToken, `?userId=${second}`).expect(400);
    expect(await db.recipeFavorite.count()).toBe(0);
  });
  it('cleans relations after recipe or account deletion and rejects missing recipes', async () => {
    const recipe = await db.recipe.create({
      data: { title: 'Delete me', servings: 1, steps: ['Cook'] },
    });
    await save(recipe.id).expect(200);
    await db.recipe.delete({ where: { id: recipe.id } });
    await save(recipe.id).expect(404);
    await remove(recipe.id).expect(404);
    expect(await db.recipeFavorite.count()).toBe(0);
    const user = await db.user.create({
      data: {
        username: 'favorites.deleted',
        fullName: 'Deleted',
        email: 'deleted@favorites.test',
      },
    });
    await db.recipeFavorite.create({
      data: { userId: user.id, recipeId: recipes[0] },
    });
    await db.user.delete({ where: { id: user.id } });
    expect(await db.recipeFavorite.count()).toBe(0);
  });
});
