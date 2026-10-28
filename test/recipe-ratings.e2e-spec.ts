import { randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { RecipeRating, User } from '../src/mongo/models';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createRecipe, createUser } from './fixtures';

describe('Recipe ratings API (e2e)', () => {
  let e2e: E2eApp;
  let rater: User;
  let author: User;
  let token: string;
  let recipeId: string;
  let root: string;
  const server = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp('ratings_e2e');
    rater = await createUser(e2e.mongo, { username: 'rater' });
    author = await createUser(e2e.mongo, { username: 'recipe.author' });
    token = await e2e.sign(rater);
    recipeId = (await createRecipe(e2e.mongo, { createdById: author.id })).id;
    root = `/api/v1/recipes/${recipeId}`;
  });
  beforeEach(async () => {
    await e2e.mongo.connection
      .model<RecipeRating>('RecipeRating')
      .deleteMany({ recipeId });
    await e2e.mongo.connection
      .model<User>('User')
      .updateOne({ _id: rater.id }, { $set: { emailVerifiedAt: new Date() } });
  });
  afterAll(async () => {
    await e2e.close();
  });

  const put = (body: object) =>
    request(server())
      .put(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const ratingCount = () =>
    e2e.mongo.connection.model<RecipeRating>('RecipeRating').countDocuments();

  it('publishes only the count and mean, without requiring login', async () => {
    await put({ value: 4 }).expect(200);
    const response = await request(server())
      .get(`${root}/ratings/summary`)
      .expect(200);
    expect(response.body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 4,
    });
  });

  it('rejects an invalid token even on the public summary endpoint', async () => {
    await request(server())
      .get(`${root}/ratings/summary`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
  });

  it.each(['get', 'put', 'delete'] as const)(
    'requires login for %s own rating',
    async (method) => {
      await request(server())
        [method](`${root}/rating`)
        .send({ value: 4 })
        .expect(401);
      expect(await ratingCount()).toBe(0);
    },
  );

  it.each([0, 6, -1, 4.5, '4', null, true])(
    'rejects an invalid rating value: %s',
    async (value) => {
      await put({ value }).expect(400);
      expect(await ratingCount()).toBe(0);
    },
  );

  it.each([
    {},
    { value: 4, userId: randomUUID() },
    { value: 4, ratingCount: 100 },
    { value: 4, averageRating: 5 },
  ])(
    'rejects missing score or client-controlled identity/aggregate: %j',
    async (body) => {
      await put(body).expect(400);
      expect(await ratingCount()).toBe(0);
    },
  );

  it('returns the authenticated caller score with private cache headers', async () => {
    await put({ value: 4 }).expect(200);
    const response = await request(server())
      .get(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({
      recipeId,
      ratingCount: 1,
      averageRating: 4,
      myRating: 4,
    });
  });

  it('stores an authenticated score and returns the resulting summary', async () => {
    const response = await put({ value: 4 }).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      ratingCount: 1,
      averageRating: 4,
      myRating: 4,
    });
  });

  it('rejects self-rating', async () => {
    const own = await createRecipe(e2e.mongo, { createdById: rater.id });
    const response = await request(server())
      .put(`/api/v1/recipes/${own.id}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 5 })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'SELF_RATING_NOT_ALLOWED' });
    expect(await ratingCount()).toBe(0);
  });

  it('does not let a token bypass unverified email', async () => {
    await e2e.mongo.connection
      .model<User>('User')
      .updateOne({ _id: rater.id }, { $set: { emailVerifiedAt: null } });
    const response = await put({ value: 5 }).expect(403);
    expect(response.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('deletes a score without returning voter data', async () => {
    await put({ value: 3 }).expect(200);
    const response = await request(server())
      .delete(`${root}/rating`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      recipeId,
      ratingCount: 0,
      averageRating: null,
      myRating: null,
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('returns 404 for a missing recipe instead of an empty summary', async () => {
    await request(server())
      .get(`/api/v1/recipes/${randomUUID()}/ratings/summary`)
      .expect(404);
  });

  it('rejects malformed recipe IDs', async () => {
    await request(server())
      .get('/api/v1/recipes/not-a-uuid/ratings/summary')
      .expect(400);
  });

  it('documents the rating endpoints and body in OpenAPI', () => {
    const doc = SwaggerModule.createDocument(
      e2e.app,
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
