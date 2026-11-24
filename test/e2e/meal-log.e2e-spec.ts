import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type {
  MealLogEntryDto,
  MealLogWeekDto,
} from '@src/meal-plan/dto/meal-log.dto.js';
import type {
  MealLogEntry,
  MealPlanEntry,
  Recipe,
  User,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createRecipe, createUser } from '@test/support/fixtures.js';

// 00:30 on Wednesday 2026-11-18 in the app time zone.
const WEEK = '2026-11-16';
const MONDAY = '2026-11-16';
const TODAY = '2026-11-18';
const WEDNESDAY_MORNING = new Date('2026-11-17T17:30:00Z');
const ROOT = '/api/v1/meal-plan/log';

describe('Meal log (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let token: string;
  let recipe: Recipe;
  const server = () => e2e.app.getHttpServer();
  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const idOf = (response: request.Response) =>
    (response.body as MealLogEntryDto).id;
  const logs = () => e2e.mongo.connection.model<MealLogEntry>('MealLogEntry');

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: WEDNESDAY_MORNING });
    e2e = await createE2eApp('meallog_e2e');
    user = await createUser(e2e.mongo, { username: 'meal.log.user' });
    token = await e2e.sign(user);
    recipe = await createRecipe(e2e.mongo, {
      title: 'Đậu hũ sốt cà',
      caloriesPerServing: 300,
    });
    await e2e.mongo.connection.model<MealPlanEntry>('MealPlanEntry').create({
      _id: randomUUID(),
      userId: user.id,
      weekStart: WEEK,
      day: 'MON',
      section: 'LUNCH',
      recipeId: recipe.id,
      position: 0,
    });
  });
  beforeEach(async () => {
    await logs().deleteMany({ userId: user.id });
  });
  afterAll(async () => {
    vi.useRealTimers();
    await e2e.close();
  });

  const create = (body: object) =>
    auth(request(server()).post(ROOT)).send(body);

  it('requires authentication', async () => {
    await request(server()).get(ROOT).expect(401);
  });

  it('logs a planned recipe with its calories and refuses it twice in one meal', async () => {
    const response = await create({
      date: MONDAY,
      section: 'LUNCH',
      recipeId: recipe.id,
      servings: 1.5,
    }).expect(201);
    expect(response.body).toMatchObject({
      source: 'PLAN',
      recipeId: recipe.id,
      name: 'Đậu hũ sốt cà',
      servings: 1.5,
      caloriesPerServing: 300,
      calories: 450,
      calorieSource: 'RECIPE',
    });
    const again = await create({
      date: MONDAY,
      section: 'LUNCH',
      recipeId: recipe.id,
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('logs a recipe outside the plan as RECIPE', async () => {
    const response = await create({
      date: MONDAY,
      section: 'DINNER',
      recipeId: recipe.id,
    }).expect(201);
    expect(response.body).toMatchObject({ source: 'RECIPE', calories: 300 });
  });

  it('logs a custom dish without calories, then with a web estimate', async () => {
    const created = await create({
      date: TODAY,
      section: 'BREAKFAST',
      name: '  Bún riêu chay  ',
    }).expect(201);
    expect(created.body).toMatchObject({
      source: 'CUSTOM',
      recipeId: null,
      name: 'Bún riêu chay',
      calories: null,
      calorieSource: null,
    });

    const updated = await auth(
      request(server()).patch(`${ROOT}/${idOf(created)}`),
    )
      .send({
        caloriesPerServing: 450,
        calorieSource: 'WEB_ESTIMATE',
        calorieNote: 'Tô vừa',
        calorieReferences: [{ title: 'Nguồn', url: 'https://example.com/a' }],
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      calories: 450,
      calorieSource: 'WEB_ESTIMATE',
      calorieNote: 'Tô vừa',
      calorieReferences: [{ title: 'Nguồn', url: 'https://example.com/a' }],
    });

    const typed = await auth(
      request(server()).patch(`${ROOT}/${idOf(created)}`),
    )
      .send({ caloriesPerServing: 400 })
      .expect(200);
    expect(typed.body).toMatchObject({
      calorieSource: 'USER',
      calorieReferences: [],
    });
  });

  it('only renames custom dishes', async () => {
    const created = await create({
      date: MONDAY,
      section: 'LUNCH',
      recipeId: recipe.id,
    }).expect(201);
    await auth(request(server()).patch(`${ROOT}/${idOf(created)}`))
      .send({ name: 'Khác' })
      .expect(400);
  });

  it.each([
    [{ date: TODAY, section: 'LUNCH' }],
    [{ date: TODAY, section: 'LUNCH', name: 'A', recipeId: randomUUID() }],
  ])('needs exactly one of recipeId and name %#', async (body) => {
    await create(body).expect(400);
  });

  it.each([
    { date: '2026-11-31', section: 'LUNCH', name: 'A' },
    { date: TODAY, section: 'BRUNCH', name: 'A' },
    { date: TODAY, section: 'LUNCH', name: 'A', servings: 0 },
    { date: TODAY, section: 'LUNCH', name: 'A', caloriesPerServing: 5001 },
    { date: TODAY, section: 'LUNCH', name: 'A', calorieSource: 'RECIPE' },
    { date: TODAY, section: 'LUNCH', name: 'A', userId: 'x' },
  ])('rejects invalid input %#', async (body) => {
    await create(body).expect(400);
  });

  it('accepts only today and the 7 days before it', async () => {
    const future = await create({
      date: '2026-11-19',
      section: 'LUNCH',
      name: 'A',
    }).expect(409);
    expect(future.body).toMatchObject({
      code: 'MEAL_LOG_LOCKED',
      details: { oldestDate: '2026-11-11', today: TODAY },
    });
    await create({ date: '2026-11-10', section: 'LUNCH', name: 'A' }).expect(
      409,
    );
    await create({ date: '2026-11-11', section: 'LUNCH', name: 'A' }).expect(
      201,
    );
  });

  it('locks old entries against change and removal', async () => {
    const old = await logs().create({
      _id: randomUUID(),
      userId: user.id,
      date: '2026-11-01',
      section: 'LUNCH',
      source: 'CUSTOM',
      name: 'Cũ',
    });
    await auth(request(server()).patch(`${ROOT}/${old.id}`))
      .send({ servings: 2 })
      .expect(409);
    await auth(request(server()).delete(`${ROOT}/${old.id}`)).expect(409);
  });

  it('caps the dishes of one meal', async () => {
    for (let index = 0; index < 10; index++) {
      await create({
        date: TODAY,
        section: 'OTHER',
        name: `Món ${index}`,
      }).expect(201);
    }
    const full = await create({
      date: TODAY,
      section: 'OTHER',
      name: 'Món 11',
    }).expect(409);
    expect(full.body).toMatchObject({ code: 'MEAL_LOG_FULL' });
  });

  it('removes only your own entries', async () => {
    const created = await create({
      date: TODAY,
      section: 'LUNCH',
      name: 'A',
    }).expect(201);
    const other = await createUser(e2e.mongo, { username: 'other.log.user' });
    await request(server())
      .delete(`${ROOT}/${idOf(created)}`)
      .set('Authorization', `Bearer ${await e2e.sign(other)}`)
      .expect(404);
    await auth(request(server()).delete(`${ROOT}/${idOf(created)}`)).expect(
      204,
    );
    await auth(request(server()).delete(`${ROOT}/${idOf(created)}`)).expect(
      404,
    );
  });

  it('summarises the week beside the plan, averaging finished complete days', async () => {
    await create({
      date: MONDAY,
      section: 'LUNCH',
      recipeId: recipe.id,
      servings: 2,
    }).expect(201);
    await create({ date: '2026-11-17', section: 'LUNCH', name: 'Phở' }).expect(
      201,
    );
    await create({
      date: TODAY,
      section: 'BREAKFAST',
      name: 'Xôi',
      caloriesPerServing: 350,
    }).expect(201);

    const response = await auth(
      request(server()).get(`${ROOT}?weekStart=${WEEK}`),
    ).expect(200);
    const week = response.body as MealLogWeekDto;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(week).toMatchObject({ weekStart: WEEK, today: TODAY });
    expect(week.days).toHaveLength(7);
    expect(week.days[0]).toMatchObject({
      date: MONDAY,
      loggable: true,
      loggedCalories: 600,
      unknownCalorieEntries: 0,
      plannedCalories: 300,
    });
    expect(week.days[1]).toMatchObject({
      loggedCalories: 0,
      unknownCalorieEntries: 1,
      plannedCalories: null,
    });
    expect(week.days[3]).toMatchObject({ loggable: false, entries: [] });
    expect(week.summary).toEqual({
      loggedDays: 3,
      completeDays: 1,
      averageCalories: 600,
      remainingDays: 5,
    });
  });

  it('keeps the entry when its recipe is deleted', async () => {
    const extra = await createRecipe(e2e.mongo, {
      title: 'Canh rau',
      caloriesPerServing: 80,
    });
    const created = await create({
      date: TODAY,
      section: 'DINNER',
      recipeId: extra.id,
    }).expect(201);
    await e2e.mongo.connection
      .model<Recipe>('Recipe')
      .deleteOne({ _id: extra.id });
    const entry = await logs().findById(idOf(created)).exec();
    expect(entry).toMatchObject({ recipeId: null, name: 'Canh rau' });
  });

  it('validates a calorie estimate request before calling AI', async () => {
    await auth(request(server()).post(`${ROOT}/calorie-estimate`))
      .send({ name: '' })
      .expect(400);
  });
});
