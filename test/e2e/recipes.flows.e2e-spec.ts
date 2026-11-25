import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  AccountStatus,
  type Ingredient,
  type IngredientGroup,
  type MealPlanEntry,
  type Recipe,
  type RecipeFavorite,
  type User,
  UserRole,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { nextWeekStart } from '@test/support/meal-week.js';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '@test/support/fixtures.js';

interface ErrorBody {
  statusCode: number;
  code: string;
}

interface RecipeIngredientBody {
  ingredientId: string;
  name: string;
  quantity: number | null;
  unit: string | null;
}

interface RecipeBody {
  id: string;
  title: string;
  description: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes?: number | null;
  ingredients: RecipeIngredientBody[];
}

interface PageBody<T> {
  items: T[];
  meta: { totalItems: number };
}

interface FavoriteBody {
  id: string;
  savedAt: string;
}

/** Meal plans are saved per week, and past days are locked. */
const NEXT_WEEK = nextWeekStart();

describe('Recipe catalog and admin flows (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let adminToken: string;
  let memberToken: string;
  let tofu: Ingredient;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  const asAdmin = (test: request.Test) =>
    test.set('Authorization', `Bearer ${adminToken}`);
  const asMember = (test: request.Test) =>
    test.set('Authorization', `Bearer ${memberToken}`);

  const recipeBody = (ingredientIds: string[], fields: object = {}) => ({
    title: 'Đậu hũ kho',
    servings: 2,
    ingredients: ingredientIds.map((ingredientId) => ({
      ingredientId,
      quantity: 100,
      unit: 'g',
    })),
    steps: ['Kho đậu'],
    ...fields,
  });

  async function signedUser(fields: Partial<User> = {}) {
    const user = await createUser(e2e.mongo, fields);
    return { user, token: await e2e.sign(user) };
  }

  beforeAll(async () => {
    e2e = await createE2eApp('recipes_flows_e2e');
    ({ user: admin, token: adminToken } = await signedUser({
      role: UserRole.ADMIN,
    }));
    ({ token: memberToken } = await signedUser());
    tofu = await createIngredient(e2e.mongo, {
      name: 'Đậu hũ non',
      aliases: ['Tàu hũ'],
    });
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('admin authorization', () => {
    it('rejects a guest creating a recipe with 401', async () => {
      await request(server())
        .post('/api/v1/admin/recipes')
        .send(recipeBody([tofu.id]))
        .expect(401);
    });

    it.each([
      ['post', '/api/v1/admin/recipes'],
      ['post', '/api/v1/admin/ingredients'],
      ['post', '/api/v1/admin/ingredient-groups'],
      ['post', '/api/v1/admin/incompatibility-rules'],
    ] as const)(
      'rejects a member calling %s %s with 403',
      async (method, path) => {
        const response = await asMember(request(server())[method](path))
          .send({})
          .expect(403);
        expect((response.body as ErrorBody).code).toBe('FORBIDDEN');
      },
    );

    it('rejects a member deleting a recipe and keeps the recipe', async () => {
      const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
      await asMember(
        request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
      ).expect(403);
      expect(
        await model<Recipe>('Recipe').countDocuments({ _id: recipe.id }),
      ).toBe(1);
    });

    it('rejects a suspended admin with 401 ACCOUNT_SUSPENDED', async () => {
      const { token } = await signedUser({
        role: UserRole.ADMIN,
        status: AccountStatus.SUSPENDED,
      });
      const response = await request(server())
        .post('/api/v1/admin/recipes')
        .set('Authorization', `Bearer ${token}`)
        .send(recipeBody([tofu.id]))
        .expect(401);
      expect((response.body as ErrorBody).code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('recipe create, replace and delete', () => {
    it('trims the title and keeps the ingredient order as entered', async () => {
      const second = await createIngredient(e2e.mongo);
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(recipeBody([second.id, tofu.id], { title: '  Canh chua  ' }))
        .expect(201);
      const body = response.body as RecipeBody;
      expect(body.title).toBe('Canh chua');
      expect(body.ingredients.map(({ ingredientId }) => ingredientId)).toEqual([
        second.id,
        tofu.id,
      ]);
    });

    it('replaces the whole recipe on PUT, clearing optional fields left out', async () => {
      const created = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(
          recipeBody([tofu.id], {
            description: 'Món cũ',
            prepMinutes: 10,
            cookMinutes: 5,
          }),
        )
        .expect(201);
      const id = (created.body as RecipeBody).id;

      const replaced = await asAdmin(
        request(server()).put(`/api/v1/admin/recipes/${id}`),
      )
        .send(recipeBody([tofu.id], { title: 'Món mới' }))
        .expect(200);

      expect(replaced.body).toMatchObject({
        title: 'Món mới',
        description: null,
        prepMinutes: null,
        cookMinutes: null,
      });
    });

    it('answers 404 NOT_FOUND when replacing a recipe that does not exist', async () => {
      const response = await asAdmin(
        request(server()).put(`/api/v1/admin/recipes/${randomUUID()}`),
      )
        .send(recipeBody([tofu.id]))
        .expect(404);
      expect((response.body as ErrorBody).code).toBe('NOT_FOUND');
    });

    it('deletes a recipe once and answers 404 on the second delete', async () => {
      const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
      await asAdmin(
        request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
      ).expect(204);
      await asAdmin(
        request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
      ).expect(404);
    });

    it('accepts the largest documented quantity, 999999.99', async () => {
      const body = recipeBody([tofu.id]);
      body.ingredients[0].quantity = 999999.99;
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(body)
        .expect(201);
      expect((response.body as RecipeBody).ingredients[0].quantity).toBe(
        999999.99,
      );
    });

    it.each([
      ['a zero quantity', { quantity: 0 }],
      ['a quantity with three decimals', { quantity: 0.001 }],
      ['a quantity above 999999.99', { quantity: 1000000 }],
      ['a quantity sent as text', { quantity: '100' }],
      ['a unit longer than 30 characters', { unit: 'g'.repeat(31) }],
    ])('rejects %s with 400 VALIDATION_FAILED', async (_name, override) => {
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(
          recipeBody([], {
            ingredients: [{ ingredientId: tofu.id, ...override }],
          }),
        )
        .expect(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['a whitespace-only step', { steps: ['   '] }],
      ['no steps', { steps: [] }],
      ['no ingredients', { ingredients: [] }],
      ['a null ingredient entry', { ingredients: [null] }],
      ['zero servings', { servings: 0 }],
      ['101 servings', { servings: 101 }],
      ['fractional prep minutes', { prepMinutes: 1.5 }],
      ['more than a day of cook minutes', { cookMinutes: 1441 }],
      ['a title of only spaces', { title: '   ' }],
      ['an undeclared field', { createdById: randomUUID() }],
    ])('rejects %s with 400 VALIDATION_FAILED', async (_name, override) => {
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(recipeBody([tofu.id], override))
        .expect(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('rejects 51 ingredients with 400', async () => {
      const ids = Array.from({ length: 51 }, () => randomUUID());
      await asAdmin(request(server()).post('/api/v1/admin/recipes'))
        .send(recipeBody(ids))
        .expect(400);
    });

    it('rejects an unknown source post with 400 UNKNOWN_REFERENCE', async () => {
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(recipeBody([tofu.id], { postId: randomUUID() }))
        .expect(400);
      expect((response.body as ErrorBody).code).toBe('UNKNOWN_REFERENCE');
    });

    it('does not expose the creating admin on the public detail', async () => {
      const created = await asAdmin(
        request(server()).post('/api/v1/admin/recipes'),
      )
        .send(recipeBody([tofu.id]))
        .expect(201);
      const detail = await request(server())
        .get(`/api/v1/recipes/${(created.body as RecipeBody).id}`)
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toContain(admin.id);
      expect(detail.body).not.toHaveProperty('createdById');
    });
  });

  describe('ingredients', () => {
    it('answers 409 NAME_TAKEN when creating a duplicate name, even with padding', async () => {
      const name = `Nấm ${randomUUID().slice(0, 6)}`;
      await asAdmin(request(server()).post('/api/v1/admin/ingredients'))
        .send({ name })
        .expect(201);
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/ingredients'),
      )
        .send({ name: `  ${name} ` })
        .expect(409);
      expect((response.body as ErrorBody).code).toBe('NAME_TAKEN');
    });

    it('answers 409 NAME_TAKEN when renaming onto an existing name', async () => {
      const first = await createIngredient(e2e.mongo);
      const second = await createIngredient(e2e.mongo);
      const response = await asAdmin(
        request(server()).put(`/api/v1/admin/ingredients/${second.id}`),
      )
        .send({ name: first.name })
        .expect(409);
      expect((response.body as ErrorBody).code).toBe('NAME_TAKEN');
    });

    it('rejects an unknown group id with 400 UNKNOWN_REFERENCE and creates nothing', async () => {
      const name = `Gừng ${randomUUID().slice(0, 6)}`;
      const response = await asAdmin(
        request(server()).post('/api/v1/admin/ingredients'),
      )
        .send({ name, groupIds: [randomUUID()] })
        .expect(400);
      expect((response.body as ErrorBody).code).toBe('UNKNOWN_REFERENCE');
      expect(
        await model<Ingredient>('Ingredient').countDocuments({ name }),
      ).toBe(0);
    });

    it('answers 404 when deleting an ingredient that does not exist', async () => {
      await asAdmin(
        request(server()).delete(`/api/v1/admin/ingredients/${randomUUID()}`),
      ).expect(404);
    });

    it('removes a deleted ingredient from groups', async () => {
      const doomed = await createIngredient(e2e.mongo);
      const kept = await createIngredient(e2e.mongo);
      const group = await model<IngredientGroup>('IngredientGroup').create({
        _id: randomUUID(),
        name: `Nhóm ${randomUUID().slice(0, 6)}`,
        dietary: true,
        ingredientIds: [doomed.id, kept.id],
      });
      await asAdmin(
        request(server()).delete(`/api/v1/admin/ingredients/${doomed.id}`),
      ).expect(204);

      const storedGroup = await model<IngredientGroup>('IngredientGroup')
        .findOne({ _id: group.id })
        .exec();
      expect(storedGroup?.ingredientIds).toEqual([kept.id]);
    });

    it('counts the recipes that use an ingredient in the admin list', async () => {
      const counted = await createIngredient(e2e.mongo, {
        name: 'AAA counted',
      });
      await createRecipe(e2e.mongo, {}, [counted.id]);
      await createRecipe(e2e.mongo, {}, [counted.id]);
      const response = await asAdmin(
        request(server()).get('/api/v1/admin/ingredients?limit=50'),
      ).expect(200);
      const row = (
        response.body as PageBody<{ id: string; recipeCount: number }>
      ).items.find(({ id }) => id === counted.id);
      expect(row?.recipeCount).toBe(2);
    });
  });

  describe('public catalog search and filters', () => {
    it('matches an upper-case Vietnamese query against a lower-case title', async () => {
      const recipe = await createRecipe(
        e2e.mongo,
        { title: 'Bún riêu chay đặc biệt' },
        [tofu.id],
      );
      const response = await request(server())
        .get('/api/v1/recipes')
        .query({ q: 'RIÊU CHAY ĐẶC', limit: 50 })
        .expect(200);
      const ids = (response.body as PageBody<RecipeBody>).items.map(
        ({ id }) => id,
      );
      expect(ids).toContain(recipe.id);
    });

    it('matches a lower-case query against a capitalised ingredient alias', async () => {
      const recipe = await createRecipe(e2e.mongo, { title: 'Món alias' }, [
        tofu.id,
      ]);
      const response = await request(server())
        .get('/api/v1/recipes')
        .query({ q: 'tàu hũ', limit: 50 })
        .expect(200);
      const ids = (response.body as PageBody<RecipeBody>).items.map(
        ({ id }) => id,
      );
      expect(ids).toContain(recipe.id);
    });

    it.each([
      ['a repeated q', 'q=a&q=b'],
      ['a repeated maxMinutes', 'maxMinutes=10&maxMinutes=20'],
      ['maxMinutes above 2880', 'maxMinutes=2881'],
      ['a negative maxMinutes', 'maxMinutes=-1'],
      ['a fractional maxMinutes', 'maxMinutes=1.5'],
      ['suitableForMe=1', 'suitableForMe=1'],
      ['limit above 50', 'limit=51'],
      ['page 0', 'page=0'],
      ['a q longer than 100 characters', `q=${'a'.repeat(101)}`],
      ['an undeclared sort', 'sort=title'],
    ])('rejects %s with 400', async (_name, query) => {
      await request(server()).get(`/api/v1/recipes?${query}`).expect(400);
    });

    it('breaks equal updatedAt ties by id descending', async () => {
      const updatedAt = new Date('2001-01-01T00:00:00.000Z');
      const title = `Tie ${randomUUID().slice(0, 8)}`;
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await model<Recipe>('Recipe').collection.insertMany(
        ids.map((id) => ({
          _id: id,
          title,
          servings: 1,
          steps: ['x'],
          ingredients: [],
          createdAt: updatedAt,
          updatedAt,
        })),
      );
      const stored = await model<Recipe>('Recipe')
        .find({ _id: { $in: ids } })
        .exec();
      expect(stored.map((row) => row.updatedAt.toISOString())).toEqual(
        ids.map(() => updatedAt.toISOString()),
      );
      const response = await request(server())
        .get('/api/v1/recipes')
        .query({ q: title, limit: 50 })
        .expect(200);
      const returned = (response.body as PageBody<RecipeBody>).items.map(
        ({ id }) => id,
      );
      expect(returned).toEqual([...ids].sort().reverse());
    });

    it.each([
      ['an empty Authorization header', ''],
      ['Bearer undefined', 'Bearer undefined'],
      ['a malformed token', 'Bearer not-a-jwt'],
    ])('answers 401 to %s instead of serving a guest', async (_name, value) => {
      await request(server())
        .get('/api/v1/recipes')
        .set('Authorization', value)
        .expect(401);
    });

    it('answers 401 to a token whose account was deleted', async () => {
      const { user, token } = await signedUser();
      await model<User>('User').deleteOne({ _id: user.id });
      await request(server())
        .get('/api/v1/recipes')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('answers 401 ACCOUNT_SUSPENDED to a suspended account on the catalog', async () => {
      const { token } = await signedUser({ status: AccountStatus.SUSPENDED });
      const response = await request(server())
        .get('/api/v1/recipes')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect((response.body as ErrorBody).code).toBe('ACCOUNT_SUSPENDED');
    });

    it('excludes a recipe from suitableForMe when it contains an ingredient the user is allergic to', async () => {
      const peanut = await createIngredient(e2e.mongo, {
        name: `Đậu phộng ${randomUUID().slice(0, 6)}`,
      });
      const title = `Peanut ${randomUUID().slice(0, 8)}`;
      await createRecipe(e2e.mongo, { title }, [peanut.id]);
      const { token } = await signedUser({ allergies: ['Dị ứng đậu phộng'] });
      const response = await request(server())
        .get('/api/v1/recipes')
        .query({ q: title, suitableForMe: 'true' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((response.body as PageBody<RecipeBody>).meta.totalItems).toBe(0);
    });
  });

  describe('recipe deletion cascade', () => {
    it('removes a deleted recipe from the owner meal plan and shopping list', async () => {
      const { token } = await signedUser();
      const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
      await request(server())
        .put('/api/v1/meal-plan/days')
        .set('Authorization', `Bearer ${token}`)
        .send({
          weekStart: NEXT_WEEK,
          days: [
            {
              day: 'MON',
              breakfast: [],
              lunch: [recipe.id],
              dinner: [],
              others: [],
            },
          ],
        })
        .expect(200);

      await asAdmin(
        request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
      ).expect(204);

      expect(
        await model<MealPlanEntry>('MealPlanEntry').countDocuments({
          recipeId: recipe.id,
        }),
      ).toBe(0);
      const shopping = await request(server())
        .get('/api/v1/meal-plan/shopping-list')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((shopping.body as { items: unknown[] }).items).toEqual([]);
    });
  });

  // Each test races up to 100 transactions; give them more than the default 5s.
  describe(
    'concurrent writes against recipe deletion',
    { timeout: 60_000 },
    () => {
      const ATTEMPTS = 25;
      const MEAL_PLAN_ATTEMPTS = 100;

      async function orphanCount(
        name: 'RecipeFavorite' | 'RecipeRating' | 'MealPlanEntry',
        recipeIds: string[],
      ): Promise<number> {
        const live = await model<Recipe>('Recipe')
          .find({ _id: { $in: recipeIds } })
          .select('_id')
          .exec();
        const liveIds = new Set(live.map(({ id }) => id));
        const missing = recipeIds.filter((id) => !liveIds.has(id));
        return model<{ recipeId: string }>(name).countDocuments({
          recipeId: { $in: missing },
        });
      }

      it('removes a favorite when the recipe is deleted afterwards (sequential control)', async () => {
        const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
        await asMember(
          request(server()).put(`/api/v1/recipes/${recipe.id}/favorite`),
        )
          .send({})
          .expect(200);
        await asAdmin(
          request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
        ).expect(204);
        expect(await orphanCount('RecipeFavorite', [recipe.id])).toBe(0);
      });

      it('removes a rating when the recipe is deleted afterwards (sequential control)', async () => {
        const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
        await asMember(
          request(server()).put(`/api/v1/recipes/${recipe.id}/rating`),
        )
          .send({ value: 4 })
          .expect(200);
        await asAdmin(
          request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
        ).expect(204);
        expect(await orphanCount('RecipeRating', [recipe.id])).toBe(0);
      });

      // BUG-1: Recipe delete takes no recipe lock, so a concurrent first-time favorite/rating commits after the cascade (orphan rows)
      it('never leaves a favorite pointing at a deleted recipe', async () => {
        const recipeIds: string[] = [];
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
          recipeIds.push(recipe.id);
          await Promise.all([
            asMember(
              request(server()).put(`/api/v1/recipes/${recipe.id}/favorite`),
            ).send({}),
            asAdmin(
              request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
            ),
          ]);
        }
        expect(await orphanCount('RecipeFavorite', recipeIds)).toBe(0);
      });

      // BUG-1: Recipe delete takes no recipe lock, so a concurrent first-time favorite/rating commits after the cascade (orphan rows)
      it('never leaves a rating pointing at a deleted recipe', async () => {
        const recipeIds: string[] = [];
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
          recipeIds.push(recipe.id);
          await Promise.all([
            asMember(
              request(server()).put(`/api/v1/recipes/${recipe.id}/rating`),
            ).send({ value: 4 }),
            asAdmin(
              request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
            ),
          ]);
        }
        expect(await orphanCount('RecipeRating', recipeIds)).toBe(0);
      });

      // BUG-6: PUT /meal-plan/days checks recipes in preview() outside its transaction, so a recipe deleted meanwhile is saved (intermittent, ~1 in 25-100 races)
      it('never leaves a meal-plan entry pointing at a deleted recipe', async () => {
        const { token } = await signedUser();
        const recipeIds: string[] = [];
        for (let attempt = 0; attempt < MEAL_PLAN_ATTEMPTS; attempt++) {
          const recipe = await createRecipe(e2e.mongo, {}, [tofu.id]);
          recipeIds.push(recipe.id);
          await Promise.all([
            request(server())
              .put('/api/v1/meal-plan/days')
              .set('Authorization', `Bearer ${token}`)
              .send({
                weekStart: NEXT_WEEK,
                days: [
                  {
                    day: 'TUE',
                    breakfast: [],
                    lunch: [recipe.id],
                    dinner: [],
                    others: [],
                  },
                ],
              }),
            asAdmin(
              request(server()).delete(`/api/v1/admin/recipes/${recipe.id}`),
            ),
          ]);
        }
        expect(await orphanCount('MealPlanEntry', recipeIds)).toBe(0);
      });

      // BUG-2: Ingredient delete and recipe create check references in different snapshots, leaving a recipe with a missing ingredient
      it('never both deletes an ingredient and saves a recipe that uses it', async () => {
        let bothSucceeded = 0;
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const ingredient = await createIngredient(e2e.mongo);
          const [created, deleted] = await Promise.all([
            asAdmin(request(server()).post('/api/v1/admin/recipes')).send(
              recipeBody([ingredient.id]),
            ),
            asAdmin(
              request(server()).delete(
                `/api/v1/admin/ingredients/${ingredient.id}`,
              ),
            ),
          ]);
          if (created.status === 201 && deleted.status === 204) bothSucceeded++;
        }
        expect(bothSucceeded).toBe(0);
      });
    },
  );

  describe('favorites list after a dangling favorite', () => {
    async function seedFavoritesWithDanglingNewest() {
      const { user, token } = await signedUser();
      const older = await createRecipe(e2e.mongo, { title: 'Older' }, [
        tofu.id,
      ]);
      const newer = await createRecipe(e2e.mongo, { title: 'Newer' }, [
        tofu.id,
      ]);
      const olderSavedAt = new Date('2026-01-01T00:00:00.000Z');
      const newerSavedAt = new Date('2026-02-01T00:00:00.000Z');
      await model<RecipeFavorite>('RecipeFavorite').collection.insertMany([
        {
          _id: randomUUID(),
          userId: user.id,
          recipeId: older.id,
          createdAt: olderSavedAt,
        },
        {
          _id: randomUUID(),
          userId: user.id,
          recipeId: newer.id,
          createdAt: newerSavedAt,
        },
        {
          _id: randomUUID(),
          userId: user.id,
          recipeId: randomUUID(),
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        },
      ]);
      const response = await request(server())
        .get('/api/v1/recipes/favorites')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return {
        body: response.body as PageBody<FavoriteBody>,
        older,
        newer,
        olderSavedAt,
        newerSavedAt,
      };
    }

    // BUG-3: Favorites list pairs savedAt by index after dropping a missing recipe, shifting every later savedAt
    it('reports each saved recipe with its own savedAt', async () => {
      const { body, older, newer, olderSavedAt, newerSavedAt } =
        await seedFavoritesWithDanglingNewest();
      expect(body.items.map(({ id, savedAt }) => ({ id, savedAt }))).toEqual([
        { id: newer.id, savedAt: newerSavedAt.toISOString() },
        { id: older.id, savedAt: olderSavedAt.toISOString() },
      ]);
    });

    // BUG-3: Favorites list counts favorites of missing recipes in totalItems
    it('counts only the recipes it can list in totalItems', async () => {
      const { body } = await seedFavoritesWithDanglingNewest();
      expect(body.meta.totalItems).toBe(2);
    });
  });
});
