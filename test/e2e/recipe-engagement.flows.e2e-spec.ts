import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { RecipeFavorite, User } from '../../src/mongo/models.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '../support/fixtures.js';

interface ErrorBody {
  code: string;
}

interface RatingBody {
  recipeId: string;
  ratingCount: number;
  averageRating: number | null;
  myRating?: number | null;
}

interface FavoritesPage {
  items: { id: string; savedAt: string; isFavorite: boolean }[];
  meta: { totalItems: number; page: number };
}

describe('Recipe favorites and ratings flows (e2e)', () => {
  let e2e: E2eApp;
  let ingredientId: string;
  const server = () => e2e.app.getHttpServer();

  async function signedUser(fields: Partial<User> = {}) {
    const user = await createUser(e2e.mongo, fields);
    return { user, token: await e2e.sign(user) };
  }

  const newRecipe = (fields: object = {}) =>
    createRecipe(e2e.mongo, fields, [ingredientId]);

  beforeAll(async () => {
    e2e = await createE2eApp('engagement_flows_e2e');
    ingredientId = (await createIngredient(e2e.mongo)).id;
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('favorites', () => {
    const save = (token: string, recipeId: string, body: object = {}) =>
      request(server())
        .put(`/api/v1/recipes/${recipeId}/favorite`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const unsave = (token: string, recipeId: string) =>
      request(server())
        .delete(`/api/v1/recipes/${recipeId}/favorite`)
        .set('Authorization', `Bearer ${token}`);
    const list = (token: string, query = '') =>
      request(server())
        .get(`/api/v1/recipes/favorites${query}`)
        .set('Authorization', `Bearer ${token}`);

    it('rejects a guest saving a recipe with 401', async () => {
      const recipe = await newRecipe();
      await request(server())
        .put(`/api/v1/recipes/${recipe.id}/favorite`)
        .expect(401);
    });

    it('rejects an undeclared body field with 400', async () => {
      const { token } = await signedUser();
      const recipe = await newRecipe();
      await save(token, recipe.id, { isFavorite: false }).expect(400);
    });

    it('answers 404 to saving a recipe that does not exist', async () => {
      const { token } = await signedUser();
      const response = await save(token, randomUUID()).expect(404);
      expect((response.body as ErrorBody).code).toBe('NOT_FOUND');
    });

    it('answers 404 to unsaving a recipe that does not exist', async () => {
      const { token } = await signedUser();
      await unsave(token, randomUUID()).expect(404);
    });

    it('answers 200 isFavorite=false to unsaving a recipe never saved', async () => {
      const { token } = await signedUser();
      const recipe = await newRecipe();
      const response = await unsave(token, recipe.id).expect(200);
      expect(response.body).toEqual({ recipeId: recipe.id, isFavorite: false });
    });

    it('gives a new savedAt after unsaving and saving again', async () => {
      const { user, token } = await signedUser();
      const recipe = await newRecipe();
      await save(token, recipe.id).expect(200);
      const favorites =
        e2e.mongo.connection.model<RecipeFavorite>('RecipeFavorite');
      await favorites.updateOne(
        { userId: user.id, recipeId: recipe.id },
        { $set: { createdAt: new Date('2020-01-01T00:00:00.000Z') } },
      );
      await unsave(token, recipe.id).expect(200);
      await save(token, recipe.id).expect(200);
      const page = (await list(token).expect(200)).body as FavoritesPage;
      expect(page.items).toHaveLength(1);
      expect(new Date(page.items[0].savedAt).getUTCFullYear()).toBeGreaterThan(
        2020,
      );
    });

    it('returns an empty out-of-range page with the real total', async () => {
      const { token } = await signedUser();
      const recipe = await newRecipe();
      await save(token, recipe.id).expect(200);
      const page = (await list(token, '?page=5&limit=1').expect(200))
        .body as FavoritesPage;
      expect(page.items).toEqual([]);
      expect(page.meta.totalItems).toBe(1);
    });

    it('lists only the caller favorites', async () => {
      const first = await signedUser();
      const second = await signedUser();
      const recipe = await newRecipe();
      await save(first.token, recipe.id).expect(200);
      const page = (await list(second.token).expect(200)).body as FavoritesPage;
      expect(page.meta.totalItems).toBe(0);
    });

    it('marks the detail as favorite only for the account that saved it', async () => {
      const first = await signedUser();
      const second = await signedUser();
      const recipe = await newRecipe();
      await save(first.token, recipe.id).expect(200);
      const mine = await request(server())
        .get(`/api/v1/recipes/${recipe.id}`)
        .set('Authorization', `Bearer ${first.token}`)
        .expect(200);
      const theirs = await request(server())
        .get(`/api/v1/recipes/${recipe.id}`)
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);
      const guest = await request(server())
        .get(`/api/v1/recipes/${recipe.id}`)
        .expect(200);
      expect(mine.body).toMatchObject({ isFavorite: true });
      expect(theirs.body).toMatchObject({ isFavorite: false });
      expect(guest.body).toMatchObject({ isFavorite: false });
      expect(mine.headers['cache-control']).toBe('private, no-store');
    });
  });

  describe('ratings', () => {
    const rate = (token: string, recipeId: string, body: unknown) =>
      request(server())
        .put(`/api/v1/recipes/${recipeId}/rating`)
        .set('Authorization', `Bearer ${token}`)
        .send(body as object);
    const unrate = (token: string, recipeId: string) =>
      request(server())
        .delete(`/api/v1/recipes/${recipeId}/rating`)
        .set('Authorization', `Bearer ${token}`);
    const summary = (recipeId: string) =>
      request(server()).get(`/api/v1/recipes/${recipeId}/ratings/summary`);

    it.each([
      ['a numeric string', { value: '4' }],
      ['a fraction', { value: 3.5 }],
      ['zero', { value: 0 }],
      ['six', { value: 6 }],
      ['null', { value: null }],
      ['no value', {}],
      ['an injected aggregate', { value: 4, ratingCount: 99 }],
      ['an injected owner', { value: 4, userId: randomUUID() }],
    ])('rejects %s with 400 VALIDATION_FAILED', async (_name, body) => {
      const { token } = await signedUser();
      const recipe = await newRecipe();
      const response = await rate(token, recipe.id, body).expect(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it.each([
      [[1, 2], 1.5],
      [[4, 4, 4, 5], 4.3],
      [[4, 4, 5], 4.3],
      [[1, 1, 2], 1.3],
      [[5, 5, 5], 5],
    ])(
      'reports scores %j as averageRating %d',
      async (scores: number[], expected: number) => {
        const recipe = await newRecipe();
        for (const value of scores) {
          const { token } = await signedUser();
          await rate(token, recipe.id, { value }).expect(200);
        }
        const response = await summary(recipe.id).expect(200);
        expect(response.body).toEqual({
          recipeId: recipe.id,
          ratingCount: scores.length,
          averageRating: expected,
        });
      },
    );

    it('lets an unverified account withdraw its existing score', async () => {
      const { user, token } = await signedUser();
      const recipe = await newRecipe();
      await rate(token, recipe.id, { value: 2 }).expect(200);
      await e2e.mongo.connection
        .model<User>('User')
        .updateOne({ _id: user.id }, { $set: { emailVerifiedAt: null } });
      const response = await unrate(token, recipe.id).expect(200);
      expect(response.body).toMatchObject({ myRating: null, ratingCount: 0 });
    });

    it('lets the author remove a score even though rating is refused', async () => {
      const { user, token } = await signedUser();
      const recipe = await newRecipe({ createdById: user.id });
      await rate(token, recipe.id, { value: 5 }).expect(403);
      await unrate(token, recipe.id).expect(200);
    });

    it('answers 404 to removing a score on a recipe that does not exist', async () => {
      const { token } = await signedUser();
      await unrate(token, randomUUID()).expect(404);
    });

    it('drops a deleted account score from the summary', async () => {
      const recipe = await newRecipe();
      const kept = await signedUser();
      const leaving = await signedUser();
      await rate(kept.token, recipe.id, { value: 5 }).expect(200);
      await rate(leaving.token, recipe.id, { value: 1 }).expect(200);
      await e2e.mongo.withTransaction((session) =>
        e2e.mongo.connection
          .model<User>('User')
          .deleteOne({ _id: leaving.user.id }, { session })
          .exec(),
      );
      const body = (await summary(recipe.id).expect(200)).body as RatingBody;
      expect(body).toMatchObject({ ratingCount: 1, averageRating: 5 });
    });

    it('rejects a guest reading a personal score with 401', async () => {
      const recipe = await newRecipe();
      await request(server())
        .get(`/api/v1/recipes/${recipe.id}/rating`)
        .expect(401);
    });

    it('returns the caller score without other voters', async () => {
      const recipe = await newRecipe();
      const first = await signedUser();
      const second = await signedUser();
      await rate(first.token, recipe.id, { value: 2 }).expect(200);
      await rate(second.token, recipe.id, { value: 4 }).expect(200);
      const response = await request(server())
        .get(`/api/v1/recipes/${recipe.id}/rating`)
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);
      expect(response.body).toEqual({
        recipeId: recipe.id,
        ratingCount: 2,
        averageRating: 3,
        myRating: 4,
      });
    });
  });
});
