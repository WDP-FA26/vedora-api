import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { MongoModule } from '../src/mongo/mongo.module.js';
import {
  type Recipe,
  type RecipeRating,
  type User,
  UserRole,
} from '../src/mongo/models.js';
import { MongoService } from '../src/mongo/mongo.service.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { configureApp } from '../src/app.setup.js';
import { RecipeRatingsController } from '../src/recipes/recipe-ratings.controller.js';
import { RecipeRatingsService } from '../src/recipes/recipe-ratings.service.js';
import type { MyRecipeRatingDto } from '../src/recipes/dto/recipe-rating.dto.js';
import { createRecipe, createUser, deleteWithCascade } from './fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

describe('Recipe ratings with MongoDB', () => {
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
  let db: MongoService;
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('ratings')),
        JwtModule.register({ secret: 'recipe-ratings-database-test-secret' }),
      ],
      controllers: [RecipeRatingsController],
      providers: [
        RecipeRatingsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      await createUser(db, {
        id: ids[name],
        username: `ratings.${name}`,
        fullName: name,
        email: `${name}@ratings.test`,
        role: name === 'author' ? UserRole.ADMIN : UserRole.USER,
        emailVerifiedAt: name === 'pending' ? null : new Date(),
      });
      tokens[name] = await app
        .get(JwtService)
        .signAsync({ sub: ids[name], username: `ratings.${name}` });
    }
  });

  beforeEach(async () => {
    await db.connection.collections.recipe_ratings.deleteMany({});
    await db.connection
      .model<User>('User')
      .updateMany(
        { _id: { $in: [ids.author, ids.first, ids.second] } },
        { $set: { emailVerifiedAt: new Date() } },
      );
    if (
      !(await db.connection.model<Recipe>('Recipe').findOne({ _id: recipeId }))
    ) {
      await createRecipe(db, {
        id: recipeId,
        title: 'Đậu hũ sốt cà',
        steps: ['Nấu'],
        createdById: ids.author,
      });
    }
  });

  afterAll(async () => {
    if (app) await dropTestDatabase(app);
    if (app) await app.close();
  });

  const ratings = () => db.connection.model<RecipeRating>('RecipeRating');
  const ratingCount = () => ratings().countDocuments();
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
    expect(await ratingCount()).toBe(1);
  });

  it('computes the mean from multiple members and rounds to one decimal', async () => {
    await put(4).expect(200);
    await put(5, tokens.second).expect(200);
    const extra = await createUser(db, {
      username: 'ratings.third',
      fullName: 'Third',
      email: 'third@ratings.test',
    });
    await ratings().create({
      _id: randomUUID(),
      recipeId,
      userId: extra.id,
      value: 5,
    });
    const response = await summary().expect(200);
    expect(response.body).toEqual({
      recipeId,
      ratingCount: 3,
      averageRating: 4.7,
    });
    await deleteWithCascade(db, 'users', extra.id);
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
    expect(await ratingCount()).toBe(0);
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
    await db.connection
      .model<User>('User')
      .updateOne({ _id: ids.second }, { $set: { emailVerifiedAt: null } });
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 2,
    });
    await put(4, tokens.second).expect(403);
    await db.connection
      .model<User>('User')
      .updateOne(
        { _id: ids.second },
        { $set: { emailVerifiedAt: new Date() } },
      );
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 3.5,
    });
    expect(await ratingCount()).toBe(2);
  });

  it('handles 20 concurrent retries for one member as one rating', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => put(4)),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(200));
    expect(await ratingCount()).toBe(1);
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
    const records = await ratings().find().exec();
    const final = (await summary().expect(200)).body as MyRecipeRatingDto;
    expect(final.ratingCount).toBe(records.length);
    expect(final.averageRating).toBe(records[0]?.value ?? null);
  });

  it('keeps separate records when different members rate concurrently', async () => {
    const responses = await Promise.all([put(2), put(5, tokens.second)]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(await ratingCount()).toBe(2);
    expect((await summary().expect(200)).body).toEqual({
      recipeId,
      ratingCount: 2,
      averageRating: 3.5,
    });
  });

  it.each([0, 6])('rejects score %s', async (value) => {
    await put(value).expect(400);
    expect(await ratingCount()).toBe(0);
  });

  // MongoDB has no foreign keys: the service checks the recipe itself.
  it('enforces unique member/recipe pairs in the database', async () => {
    await put(4).expect(200);
    await expect(
      ratings().create({
        _id: randomUUID(),
        recipeId,
        userId: ids.first,
        value: 5,
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await ratingCount()).toBe(1);
  });

  it('does not recreate ratings or summaries after recipe deletion, including a concurrent PUT', async () => {
    await put(4).expect(200);
    const [response] = await Promise.all([
      put(5),
      deleteWithCascade(db, 'recipes', recipeId),
    ]);
    expect([200, 404, 409]).toContain(response.status);
    expect(await ratingCount()).toBe(0);
    await summary().expect(404);
    await put(3).expect(404);
    await remove().expect(404);
  });
});
