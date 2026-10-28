import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { MealPlanDto } from '../src/meal-plan/dto/meal-plan.dto.js';
import type {
  Ingredient,
  MealPlanEntry,
  Recipe,
  User,
} from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createIngredient, createRecipe, createUser } from './fixtures.js';

describe('Meal plan (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let token: string;
  let tofu: Ingredient;
  let recipe: Recipe;
  let body: object;
  const server = () => e2e.app.getHttpServer();
  const entries = () =>
    e2e.mongo.connection.model<MealPlanEntry>('MealPlanEntry').countDocuments();

  beforeAll(async () => {
    e2e = await createE2eApp('mealplan_e2e');
    user = await createUser(e2e.mongo, { username: 'vedora.user' });
    token = await e2e.sign(user);
    tofu = await createIngredient(e2e.mongo, { name: 'Đậu hũ' });
    recipe = await createRecipe(
      e2e.mongo,
      { title: 'Đậu hũ sốt cà', prepMinutes: 10, steps: ['Chiên đậu'] },
      [tofu.id],
    );
    body = {
      days: [
        {
          day: 'MON',
          breakfast: [],
          lunch: [recipe.id],
          dinner: [],
          others: [],
        },
      ],
    };
  });
  beforeEach(async () => {
    await e2e.mongo.connection
      .model<MealPlanEntry>('MealPlanEntry')
      .deleteMany({ userId: user.id });
    await e2e.mongo.connection
      .model<User>('User')
      .updateOne({ _id: user.id }, { $set: { avoidedIngredientIds: [] } });
  });
  afterAll(async () => {
    await e2e.close();
  });

  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  it('requires a signed-in user', async () => {
    await request(server()).get('/api/v1/meal-plan').expect(401);
  });

  it('returns the saved timetable', async () => {
    await auth(request(server()).put('/api/v1/meal-plan/days'))
      .send(body)
      .expect(200);
    const response = await auth(
      request(server()).get('/api/v1/meal-plan'),
    ).expect(200);
    const plan = response.body as MealPlanDto;
    expect(plan.days).toHaveLength(7);
    expect(plan.days[0].sections[1]).toMatchObject({
      section: 'LUNCH',
      recipes: [{ title: 'Đậu hũ sốt cà' }],
    });
    expect(plan.problems).toEqual([]);
  });

  it('saves a valid change', async () => {
    await auth(request(server()).put('/api/v1/meal-plan/days'))
      .send(body)
      .expect(200);
    expect(await entries()).toBe(1);
  });

  it('previews a manually selected recipe without saving', async () => {
    const response = await auth(
      request(server()).post('/api/v1/meal-plan/preview'),
    )
      .send(body)
      .expect(200);
    expect(response.body).toMatchObject({
      days: [
        {
          day: 'MON',
          sections: [
            { section: 'BREAKFAST' },
            {
              section: 'LUNCH',
              recipes: [{ id: recipe.id }],
              previous: [],
            },
            { section: 'DINNER' },
            { section: 'OTHER' },
          ],
        },
      ],
      problems: [],
    });
    expect(await entries()).toBe(0);
  });

  it('requires login and validates the manual preview body', async () => {
    await request(server())
      .post('/api/v1/meal-plan/preview')
      .send(body)
      .expect(401);
    await auth(request(server()).post('/api/v1/meal-plan/preview'))
      .send({ days: [] })
      .expect(400);
  });

  it('answers 409 for a recipe with an avoided ingredient', async () => {
    await e2e.mongo.connection
      .model<User>('User')
      .updateOne(
        { _id: user.id },
        { $set: { avoidedIngredientIds: [tofu.id] } },
      );
    const response = await auth(request(server()).put('/api/v1/meal-plan/days'))
      .send(body)
      .expect(409);
    expect(response.body).toMatchObject({
      code: 'MEAL_PLAN_INVALID',
      details: {
        problems: [
          {
            code: 'AVOIDED_INGREDIENT',
            day: 'MON',
            recipes: ['Đậu hũ sốt cà'],
            recipeIds: [recipe.id],
            ingredients: ['Đậu hũ'],
          },
        ],
      },
    });
    expect(await entries()).toBe(0);
  });

  it('rejects an unknown weekday', async () => {
    await auth(request(server()).put('/api/v1/meal-plan/days'))
      .send({
        days: [
          { day: 'FUNDAY', breakfast: [], lunch: [], dinner: [], others: [] },
        ],
      })
      .expect(400);
  });

  it('returns missing recipe IDs in preview and save errors', async () => {
    const missing = randomUUID();
    const unknown = {
      days: [
        { day: 'MON', breakfast: [], lunch: [missing], dinner: [], others: [] },
      ],
    };
    for (const method of ['post', 'put'] as const) {
      const response = await auth(
        request(server())[method](
          `/api/v1/meal-plan/${method === 'post' ? 'preview' : 'days'}`,
        ),
      )
        .send(unknown)
        .expect(method === 'post' ? 200 : 409);
      // Preview returns 200 with the problems on the body; a save returns 409
      // with them under `details`.
      const body = response.body as {
        problems?: unknown;
        details?: { problems: unknown };
      };
      expect(body.problems ?? body.details?.problems).toEqual([
        {
          code: 'UNKNOWN_RECIPE',
          day: 'MON',
          recipes: [],
          recipeIds: [missing],
          ingredients: [],
          reason: null,
        },
      ]);
    }
    expect(await entries()).toBe(0);
  });
});
