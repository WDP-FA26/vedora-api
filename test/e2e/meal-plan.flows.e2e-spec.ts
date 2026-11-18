import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type {
  MealPlanDto,
  MealPlanPreviewDto,
  MealPlanProblemDto,
} from '../../src/meal-plan/dto/meal-plan.dto.js';
import type { ShoppingListDto } from '../../src/meal-plan/dto/shopping-list.dto.js';
import {
  type Ingredient,
  type IngredientGroup,
  type MealPlanEntry,
  MealSection,
  type Recipe,
  RecipeTag,
  type User,
  Weekday,
} from '../../src/mongo/models.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '../support/fixtures.js';

interface ErrorBody {
  code: string;
  details?: { problems?: MealPlanProblemDto[] };
}

type Sections = {
  breakfast?: string[];
  lunch?: string[];
  dinner?: string[];
  others?: string[];
};

const dayBody = (day: string, sections: Sections = {}) => ({
  day,
  breakfast: sections.breakfast ?? [],
  lunch: sections.lunch ?? [],
  dinner: sections.dinner ?? [],
  others: sections.others ?? [],
});

describe('Meal plan and shopping list flows (e2e)', () => {
  let e2e: E2eApp;
  let tofu: Ingredient;
  let honey: Ingredient;
  let tofuDish: Recipe;
  let honeyDish: Recipe;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  async function signedUser(fields: Partial<User> = {}) {
    const user = await createUser(e2e.mongo, fields);
    return { user, token: await e2e.sign(user) };
  }

  const putDays = (token: string, days: unknown) =>
    request(server())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send({ days });

  const previewDays = (token: string, days: unknown) =>
    request(server())
      .post('/api/v1/meal-plan/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ days });

  const getPlan = async (token: string): Promise<MealPlanDto> =>
    (
      await request(server())
        .get('/api/v1/meal-plan')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as MealPlanDto;

  const shopping = (token: string, query = '') =>
    request(server())
      .get(`/api/v1/meal-plan/shopping-list${query}`)
      .set('Authorization', `Bearer ${token}`);

  const sectionIds = (
    plan: MealPlanDto,
    day: `${Weekday}`,
    section: `${MealSection}`,
  ) =>
    plan.days
      .find((entry) => entry.day === Weekday[day])
      ?.sections.find((entry) => entry.section === MealSection[section])
      ?.recipes.map(({ id }) => id);

  beforeAll(async () => {
    e2e = await createE2eApp('mealplan_flows_e2e');
    tofu = await createIngredient(e2e.mongo, { name: 'Đậu hũ' });
    honey = await createIngredient(e2e.mongo, { name: 'Mật ong' });
    tofuDish = await createRecipe(e2e.mongo, { title: 'Đậu hũ chiên' }, [
      tofu.id,
    ]);
    honeyDish = await createRecipe(e2e.mongo, { title: 'Trà mật ong' }, [
      honey.id,
    ]);
    await model('IncompatibilityRule').create({
      _id: randomUUID(),
      aIngredientId: tofu.id,
      bIngredientId: honey.id,
      reason: 'Không ăn cùng ngày',
    });
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('timetable shape', () => {
    it('returns seven days Monday first, each with the four sections in order, for an empty plan', async () => {
      const { token } = await signedUser();
      const plan = await getPlan(token);
      expect(plan.days.map(({ day }) => day)).toEqual([
        'MON',
        'TUE',
        'WED',
        'THU',
        'FRI',
        'SAT',
        'SUN',
      ]);
      for (const day of plan.days) {
        expect(day.sections.map(({ section }) => section)).toEqual([
          'BREAKFAST',
          'LUNCH',
          'DINNER',
          'OTHER',
        ]);
      }
      expect(plan.problems).toEqual([]);
    });

    it('rejects a guest with 401', async () => {
      await request(server()).get('/api/v1/meal-plan').expect(401);
    });
  });

  describe('save body validation', () => {
    const id = () => randomUUID();
    it.each([
      ['no days', []],
      ['the same day twice', [dayBody('MON'), dayBody('MON')]],
      ['eight days', Array.from({ length: 8 }, () => dayBody('MON'))],
      [
        'seven dishes in one section',
        [dayBody('MON', { lunch: Array.from({ length: 7 }, id) })],
      ],
      [
        'the same dish twice in one section',
        [
          dayBody('MON', {
            lunch: [
              'a1a2d3e4-0000-4000-8000-000000000001',
              'a1a2d3e4-0000-4000-8000-000000000001',
            ],
          }),
        ],
      ],
      ['a dish id that is not a UUID', [dayBody('MON', { lunch: ['abc'] })]],
      ['a lower-case weekday', [dayBody('mon')]],
      [
        'a day without the others section',
        [{ day: 'MON', breakfast: [], lunch: [], dinner: [] }],
      ],
      ['a null day', [null]],
      ['an undeclared field on a day', [{ ...dayBody('MON'), snacks: [] }]],
    ])('rejects %s with 400 VALIDATION_FAILED', async (_name, days) => {
      const { token } = await signedUser();
      const response = await putDays(token, days).expect(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('saving days', () => {
    it('keeps the same dish in two sections of one day', async () => {
      const { token } = await signedUser();
      const response = await putDays(token, [
        dayBody('WED', { lunch: [tofuDish.id], dinner: [tofuDish.id] }),
      ]).expect(200);
      const plan = response.body as MealPlanDto;
      expect(sectionIds(plan, 'WED', 'LUNCH')).toEqual([tofuDish.id]);
      expect(sectionIds(plan, 'WED', 'DINNER')).toEqual([tofuDish.id]);
    });

    it('keeps the dish order sent for a section', async () => {
      const { token } = await signedUser();
      const third = await createRecipe(e2e.mongo, { title: 'Cơm' }, [tofu.id]);
      await putDays(token, [
        dayBody('THU', { dinner: [third.id, tofuDish.id] }),
      ]).expect(200);
      const plan = await getPlan(token);
      expect(sectionIds(plan, 'THU', 'DINNER')).toEqual([
        third.id,
        tofuDish.id,
      ]);
    });

    it('leaves days that are not sent untouched', async () => {
      const { token } = await signedUser();
      await putDays(token, [dayBody('MON', { lunch: [tofuDish.id] })]).expect(
        200,
      );
      await putDays(token, [dayBody('TUE', { lunch: [honeyDish.id] })]).expect(
        200,
      );
      const plan = await getPlan(token);
      expect(sectionIds(plan, 'MON', 'LUNCH')).toEqual([tofuDish.id]);
      expect(sectionIds(plan, 'TUE', 'LUNCH')).toEqual([honeyDish.id]);
    });

    it('clears a day when every section is sent empty', async () => {
      const { user, token } = await signedUser();
      await putDays(token, [dayBody('FRI', { lunch: [tofuDish.id] })]).expect(
        200,
      );
      await putDays(token, [dayBody('FRI')]).expect(200);
      expect(
        await model<MealPlanEntry>('MealPlanEntry').countDocuments({
          userId: user.id,
        }),
      ).toBe(0);
    });

    it('refuses a new dish that clashes with a dish already saved in another section of that day', async () => {
      const { token } = await signedUser();
      await putDays(token, [dayBody('SAT', { lunch: [tofuDish.id] })]).expect(
        200,
      );
      const response = await putDays(token, [
        dayBody('SAT', { lunch: [tofuDish.id], dinner: [honeyDish.id] }),
      ]).expect(409);
      const body = response.body as ErrorBody;
      expect(body.code).toBe('MEAL_PLAN_INVALID');
      expect(body.details?.problems).toEqual([
        expect.objectContaining({
          code: 'DAY_CONFLICT',
          day: 'SAT',
          recipeIds: expect.arrayContaining([
            tofuDish.id,
            honeyDish.id,
          ]) as unknown,
        }),
      ]);
    });

    it('allows moving dishes between sections of a day that already clashes', async () => {
      const { user, token } = await signedUser();
      await model<MealPlanEntry>('MealPlanEntry').insertMany([
        {
          _id: randomUUID(),
          userId: user.id,
          day: 'SUN',
          section: 'LUNCH',
          recipeId: tofuDish.id,
          position: 0,
        },
        {
          _id: randomUUID(),
          userId: user.id,
          day: 'SUN',
          section: 'DINNER',
          recipeId: honeyDish.id,
          position: 0,
        },
      ]);
      const response = await putDays(token, [
        dayBody('SUN', { breakfast: [honeyDish.id], dinner: [tofuDish.id] }),
      ]).expect(200);
      const plan = response.body as MealPlanDto;
      expect(sectionIds(plan, 'SUN', 'BREAKFAST')).toEqual([honeyDish.id]);
      expect(plan.problems.map(({ code }) => code)).toEqual(['DAY_CONFLICT']);
    });

    it('refuses a dish with an ingredient avoided through a group', async () => {
      const group = await model<IngredientGroup>('IngredientGroup').create({
        _id: randomUUID(),
        name: `Nhóm ${randomUUID().slice(0, 6)}`,
        dietary: true,
        ingredientIds: [tofu.id],
      });
      const { token } = await signedUser({ avoidedGroupIds: [group.id] });
      const response = await putDays(token, [
        dayBody('MON', { lunch: [tofuDish.id] }),
      ]).expect(409);
      expect((response.body as ErrorBody).details?.problems).toEqual([
        expect.objectContaining({
          code: 'AVOIDED_INGREDIENT',
          recipeIds: [tofuDish.id],
          ingredients: ['Đậu hũ'],
        }),
      ]);
    });

    it('reports a missing recipe id once even when it repeats across sections', async () => {
      const { token } = await signedUser();
      const missing = randomUUID();
      const response = await previewDays(token, [
        dayBody('MON', { lunch: [missing], dinner: [missing] }),
      ]).expect(200);
      const preview = response.body as MealPlanPreviewDto;
      expect(preview.problems).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_RECIPE',
          recipeIds: [missing],
          recipes: [],
        }),
      ]);
    });

    it('does not save anything on preview', async () => {
      const { user, token } = await signedUser();
      await previewDays(token, [
        dayBody('MON', { lunch: [tofuDish.id] }),
      ]).expect(200);
      expect(
        await model<MealPlanEntry>('MealPlanEntry').countDocuments({
          userId: user.id,
        }),
      ).toBe(0);
    });

    it('reports a saved dish on GET once the user starts avoiding its ingredient', async () => {
      const { token } = await signedUser();
      await putDays(token, [dayBody('TUE', { dinner: [tofuDish.id] })]).expect(
        200,
      );
      await request(server())
        .put('/api/v1/dietary/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          ingredientIds: [tofu.id],
          groupIds: [],
          likedIngredientIds: [],
        })
        .expect(200);
      const plan = await getPlan(token);
      expect(plan.problems).toEqual([
        expect.objectContaining({ code: 'AVOIDED_INGREDIENT', day: 'TUE' }),
      ]);
    });
  });

  describe('shopping list', () => {
    it.each([
      ['a trailing comma', '?days=MON,'],
      ['a lower-case day', '?days=mon'],
      ['a repeated day', '?days=MON,MON'],
      ['an empty value', '?days='],
      ['an unknown day', '?days=MON,XYZ'],
      ['an undeclared field', '?userId=abc'],
    ])('rejects %s with 400', async (_name, query) => {
      const { token } = await signedUser();
      await shopping(token, query).expect(400);
    });

    it('accepts repeated days parameters and returns days in calendar order', async () => {
      const { token } = await signedUser();
      const response = await shopping(token, '?days=SUN&days=MON').expect(200);
      expect((response.body as ShoppingListDto).days).toEqual(['MON', 'SUN']);
    });

    it('sums 0.1 and 0.2 to exactly "0.30"', async () => {
      const { token } = await signedUser();
      const salt = await createIngredient(e2e.mongo);
      const first = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: salt.id, quantity: 0.1, unit: 'kg', note: null },
        ],
      });
      const second = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: salt.id, quantity: 0.2, unit: 'kg', note: null },
        ],
      });
      await putDays(token, [
        dayBody('MON', { lunch: [first.id], dinner: [second.id] }),
      ]).expect(200);
      const response = await shopping(token, '?days=MON').expect(200);
      expect((response.body as ShoppingListDto).items).toEqual([
        expect.objectContaining({ knownQuantity: '0.30', unit: 'kg' }),
      ]);
    });

    it('merges units that differ only by surrounding spaces and keeps a different case apart', async () => {
      const { token } = await signedUser();
      const rice = await createIngredient(e2e.mongo, { name: 'Gạo' });
      const recipe = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: rice.id, quantity: 1, unit: 'g', note: null },
        ],
      });
      const padded = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: rice.id, quantity: 2, unit: ' g ', note: null },
        ],
      });
      const upper = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: rice.id, quantity: 4, unit: 'G', note: null },
        ],
      });
      await putDays(token, [
        dayBody('MON', {
          breakfast: [recipe.id],
          lunch: [padded.id],
          dinner: [upper.id],
        }),
      ]).expect(200);
      const items = (
        (await shopping(token, '?days=MON').expect(200)).body as ShoppingListDto
      ).items;
      const byUnit = new Map(items.map((item) => [item.unit, item]));
      expect(byUnit.get('g')?.knownQuantity).toBe('3.00');
      expect(byUnit.get('G')?.knownQuantity).toBe('4.00');
      expect(items).toHaveLength(2);
    });

    it('treats an empty unit as unknown and merges it with a null unit', async () => {
      const { token } = await signedUser();
      const leaf = await createIngredient(e2e.mongo);
      const empty = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: leaf.id, quantity: 1, unit: '', note: null },
        ],
      });
      const missing = await createRecipe(e2e.mongo, {
        ingredients: [
          { ingredientId: leaf.id, quantity: null, unit: null, note: null },
        ],
      });
      await putDays(token, [
        dayBody('MON', { lunch: [empty.id], dinner: [missing.id] }),
      ]).expect(200);
      const items = (
        (await shopping(token, '?days=MON').expect(200)).body as ShoppingListDto
      ).items;
      expect(items).toEqual([
        expect.objectContaining({
          unit: null,
          knownQuantity: '1.00',
          hasUnknownQuantity: true,
        }),
      ]);
    });

    it('orders contributions by day, then section, then dish position', async () => {
      const { token } = await signedUser();
      const bean = await createIngredient(e2e.mongo);
      const withBean = (title: string) =>
        createRecipe(e2e.mongo, {
          title,
          ingredients: [
            { ingredientId: bean.id, quantity: 1, unit: 'g', note: null },
          ],
        });
      const a = await withBean('A');
      const b = await withBean('B');
      const c = await withBean('C');
      await putDays(token, [
        dayBody('TUE', { breakfast: [c.id] }),
        dayBody('MON', { dinner: [b.id, a.id], breakfast: [c.id] }),
      ]).expect(200);
      const items = (
        (await shopping(token).expect(200)).body as ShoppingListDto
      ).items;
      expect(
        items[0].contributions.map(
          ({ day, section, recipeTitle }) => `${day}/${section}/${recipeTitle}`,
        ),
      ).toEqual([
        'MON/BREAKFAST/C',
        'MON/DINNER/B',
        'MON/DINNER/A',
        'TUE/BREAKFAST/C',
      ]);
      expect(items[0].knownQuantity).toBe('4.00');
    });

    it('does not count another user plan', async () => {
      const { token: other } = await signedUser();
      await putDays(other, [dayBody('MON', { lunch: [tofuDish.id] })]).expect(
        200,
      );
      const { token } = await signedUser();
      const response = await shopping(token).expect(200);
      expect((response.body as ShoppingListDto).items).toEqual([]);
    });
  });
  describe('generating dishes with the algorithm', () => {
    const generate = (token: string, body: Record<string, unknown>) =>
      request(server())
        .post('/api/v1/meal-plan/generate')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    const allDays = Object.values(Weekday);
    const meals = ['BREAKFAST', 'LUNCH', 'DINNER'];

    const dishesOf = (preview: MealPlanPreviewDto) =>
      preview.days.flatMap(({ sections }) =>
        sections.flatMap(({ recipes }) => recipes.map(({ id }) => id)),
      );

    let quick: Recipe;
    let slow: Recipe;
    let soup: Recipe;

    beforeAll(async () => {
      const rice = await createIngredient(e2e.mongo, { name: 'Gạo lứt' });
      quick = await createRecipe(
        e2e.mongo,
        { title: 'Cơm gạo lứt', prepMinutes: 5, cookMinutes: 10 },
        [rice.id],
      );
      soup = await createRecipe(
        e2e.mongo,
        {
          title: 'Canh bí',
          tag: RecipeTag.SOUP,
          prepMinutes: 5,
          cookMinutes: 20,
        },
        [rice.id],
      );
      slow = await createRecipe(
        e2e.mongo,
        { title: 'Cơm hầm lâu', prepMinutes: 30, cookMinutes: 120 },
        [rice.id],
      );
    });

    it('fills only the empty slots and keeps what is saved', async () => {
      const { token } = await signedUser();
      await putDays(token, [dayBody('MON', { lunch: [tofuDish.id] })]).expect(
        200,
      );
      const response = await generate(token, {
        days: ['MON'],
        sections: ['LUNCH', 'DINNER'],
        onlyEmpty: true,
      }).expect(200);
      const preview = response.body as MealPlanPreviewDto;
      const monday = preview.days.find(({ day }) => String(day) === 'MON');
      const section = (name: string) =>
        monday?.sections.find((entry) => String(entry.section) === name)
          ?.recipes;
      expect(section('LUNCH')?.map(({ id }) => id)).toEqual([tofuDish.id]);
      expect(section('DINNER')).toHaveLength(1);
      expect(section('DINNER')?.[0].id).not.toBe(honeyDish.id);
      expect(preview.problems).toEqual([]);
    });

    it('returns whole days with the four sections and saves nothing', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: allDays,
        sections: meals,
        onlyEmpty: false,
      }).expect(200);
      const preview = response.body as MealPlanPreviewDto;
      expect(preview.days).toHaveLength(7);
      for (const day of preview.days) {
        expect(day.sections.map(({ section }) => section)).toEqual(
          Object.values(MealSection),
        );
      }
      expect(preview.problems).toEqual([]);
      const plan = await getPlan(token);
      expect(plan.days.flatMap(({ sections }) => sections)).toSatisfy(
        (sections: { recipes: unknown[] }[]) =>
          sections.every(({ recipes }) => recipes.length === 0),
      );
    });

    it('never picks a dish with an ingredient the user avoids', async () => {
      const { token } = await signedUser({
        avoidedIngredientIds: [tofu.id],
      });
      const response = await generate(token, {
        days: allDays,
        sections: meals,
        onlyEmpty: false,
      }).expect(200);
      expect(dishesOf(response.body as MealPlanPreviewDto)).not.toContain(
        tofuDish.id,
      );
    });

    it('never puts clashing ingredients on one day', async () => {
      const { token } = await signedUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await generate(token, {
          days: allDays,
          sections: [...meals, 'OTHER'],
          onlyEmpty: false,
        }).expect(200);
        expect((response.body as MealPlanPreviewDto).problems).toEqual([]);
      }
    });

    it('leaves out dishes longer than maxMinutes and dishes without a time', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: allDays,
        sections: meals,
        onlyEmpty: false,
        maxMinutes: 20,
      }).expect(200);
      const picked = new Set(dishesOf(response.body as MealPlanPreviewDto));
      expect(picked).toEqual(new Set([quick.id]));
      expect(picked.has(slow.id)).toBe(false);
    });

    it('never picks a dish whose title or ingredients contain an excluded word', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: allDays,
        sections: meals,
        onlyEmpty: false,
        exclude: ['đậu hũ'],
      }).expect(200);
      expect(dishesOf(response.body as MealPlanPreviewDto)).not.toContain(
        tofuDish.id,
      );
    });

    it('only picks dishes of the requested tags', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: allDays,
        sections: ['LUNCH'],
        onlyEmpty: false,
        tags: ['SOUP'],
      }).expect(200);
      const picked = new Set(dishesOf(response.body as MealPlanPreviewDto));
      expect(picked).toEqual(new Set([soup.id]));
    });

    it('fills several dishes per slot without repeating one in a day', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: ['WED'],
        sections: ['DINNER'],
        onlyEmpty: false,
        perSection: 2,
        exclude: ['đậu hũ', 'mật ong'],
      }).expect(200);
      const ids = dishesOf(response.body as MealPlanPreviewDto);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('returns no days when no dish fits', async () => {
      const { token } = await signedUser();
      const response = await generate(token, {
        days: ['TUE'],
        sections: ['LUNCH'],
        onlyEmpty: true,
        maxMinutes: 1,
      }).expect(200);
      expect(response.body).toEqual({ days: [], problems: [] });
    });

    it('rejects an empty selection and unknown fields with 400', async () => {
      const { token } = await signedUser();
      await generate(token, {
        days: [],
        sections: meals,
        onlyEmpty: true,
      }).expect(400);
      await generate(token, {
        days: ['MON'],
        sections: meals,
        onlyEmpty: true,
        maxMinutes: 0,
      }).expect(400);
      await generate(token, {
        days: ['MON'],
        sections: meals,
        onlyEmpty: true,
        pantry: ['rice'],
      }).expect(400);
    });

    it('rejects a guest with 401', async () => {
      await request(server())
        .post('/api/v1/meal-plan/generate')
        .send({ days: ['MON'], sections: meals, onlyEmpty: true })
        .expect(401);
    });
  });
});
