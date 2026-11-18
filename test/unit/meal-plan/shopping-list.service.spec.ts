import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ShoppingListService } from '../../../src/meal-plan/shopping-list.service.js';
import {
  type MealPlanEntry,
  MealSection,
  Weekday,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const WEEK = '2026-11-16';
const NEXT_WEEK = '2026-11-23';
// 00:30 on Monday 2026-11-16 in the app time zone, so every day is still ahead.
const MONDAY_MORNING = new Date('2026-11-15T17:30:00Z');
const OTHER_USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff9';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const OIL_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const SALT_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const TOFU_DUP_ID = 'a1a2d3e4-0000-4000-8000-000000000004';
const ORPHAN_ING_ID = 'a1a2d3e4-0000-4000-8000-000000000099';
const RECIPE_1 = 'd1a2d3e4-0000-4000-8000-000000000001';
const RECIPE_2 = 'd1a2d3e4-0000-4000-8000-000000000002';
const RECIPE_3 = 'd1a2d3e4-0000-4000-8000-000000000003';

describe('ShoppingListService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: ShoppingListService;

  const entries = () => mongo.connection.model<MealPlanEntry>('MealPlanEntry');

  const addEntry = (
    day: Weekday,
    section: MealSection,
    recipeId: string,
    position = 0,
    userId = USER_ID,
  ) =>
    entries().create({
      _id: randomUUID(),
      userId,
      weekStart: WEEK,
      day,
      section,
      recipeId,
      position,
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: MONDAY_MORNING });
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('shopping_list'))],
      providers: [ShoppingListService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(ShoppingListService);
  });

  beforeEach(async () => {
    vi.setSystemTime(MONDAY_MORNING);
    for (const collection of [
      'meal_plan_week_entries',
      'recipes',
      'ingredients',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'shop.user' });
    await createUser(mongo, { id: OTHER_USER_ID, username: 'other.user' });
    await createIngredient(mongo, { id: TOFU_ID, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: OIL_ID, name: 'Dầu mè' });
    await createIngredient(mongo, { id: SALT_ID, name: 'Muối' });
    await createIngredient(mongo, { id: TOFU_DUP_ID, name: 'Đậu hũ non' });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await dropTestDatabase(app);
    await app.close();
  });

  it('returns an empty list and normalizes selected days to MON..SUN order', async () => {
    const result = await service.get(USER_ID, {
      days: [Weekday.SUN, Weekday.MON, Weekday.WED],
    });

    expect(result).toEqual({
      weekStart: WEEK,
      days: [Weekday.MON, Weekday.WED, Weekday.SUN],
      quantityBasis: 'RECIPE_PER_OCCURRENCE',
      items: [],
    });
  });

  it('aggregates full recipe quantities per occurrence with Decimal precision and preserves unknown quantities', async () => {
    await createRecipe(mongo, {
      id: RECIPE_1,
      title: 'Đậu hũ sốt cà',
      servings: 2,
      ingredients: [
        { ingredientId: TOFU_ID, quantity: 0.1, unit: ' g ', note: 'cắt nhỏ' },
        { ingredientId: OIL_ID, quantity: null, unit: '   ', note: 'tùy ý' },
      ],
    });
    await createRecipe(mongo, {
      id: RECIPE_2,
      title: 'Canh đậu hũ',
      servings: 4,
      ingredients: [
        { ingredientId: TOFU_ID, quantity: 0.2, unit: 'g', note: null },
        { ingredientId: OIL_ID, quantity: 10.25, unit: null, note: null },
      ],
    });

    await addEntry(Weekday.TUE, MealSection.DINNER, RECIPE_2, 0);
    await addEntry(Weekday.MON, MealSection.OTHER, RECIPE_1, 0);
    await addEntry(Weekday.MON, MealSection.LUNCH, RECIPE_1, 0);
    // Excluded day and excluded user
    await addEntry(Weekday.FRI, MealSection.LUNCH, RECIPE_2, 0);
    await addEntry(
      Weekday.MON,
      MealSection.BREAKFAST,
      RECIPE_2,
      0,
      OTHER_USER_ID,
    );

    const result = await service.get(USER_ID, {
      days: [Weekday.MON, Weekday.TUE],
    });

    expect(result.quantityBasis).toBe('RECIPE_PER_OCCURRENCE');
    expect(result.items).toEqual([
      {
        ingredientId: OIL_ID,
        name: 'Dầu mè',
        unit: null,
        knownQuantity: '10.25',
        hasUnknownQuantity: true,
        contributions: [
          {
            recipeId: RECIPE_1,
            recipeTitle: 'Đậu hũ sốt cà',
            day: Weekday.MON,
            section: MealSection.LUNCH,
            servings: 2,
            quantity: null,
            note: 'tùy ý',
          },
          {
            recipeId: RECIPE_1,
            recipeTitle: 'Đậu hũ sốt cà',
            day: Weekday.MON,
            section: MealSection.OTHER,
            servings: 2,
            quantity: null,
            note: 'tùy ý',
          },
          {
            recipeId: RECIPE_2,
            recipeTitle: 'Canh đậu hũ',
            day: Weekday.TUE,
            section: MealSection.DINNER,
            servings: 4,
            quantity: '10.25',
            note: null,
          },
        ],
      },
      {
        ingredientId: TOFU_ID,
        name: 'Đậu hũ',
        unit: 'g',
        knownQuantity: '0.40',
        hasUnknownQuantity: false,
        contributions: [
          {
            recipeId: RECIPE_1,
            recipeTitle: 'Đậu hũ sốt cà',
            day: Weekday.MON,
            section: MealSection.LUNCH,
            servings: 2,
            quantity: '0.10',
            note: 'cắt nhỏ',
          },
          {
            recipeId: RECIPE_1,
            recipeTitle: 'Đậu hũ sốt cà',
            day: Weekday.MON,
            section: MealSection.OTHER,
            servings: 2,
            quantity: '0.10',
            note: 'cắt nhỏ',
          },
          {
            recipeId: RECIPE_2,
            recipeTitle: 'Canh đậu hũ',
            day: Weekday.TUE,
            section: MealSection.DINNER,
            servings: 4,
            quantity: '0.20',
            note: null,
          },
        ],
      },
    ]);
  });

  it('keeps distinct ingredientIds and case-sensitive units separate and returns null knownQuantity when all are unknown', async () => {
    await createRecipe(mongo, {
      id: RECIPE_1,
      title: 'Món 1',
      servings: 1,
      ingredients: [
        { ingredientId: SALT_ID, quantity: null, unit: '', note: null },
        { ingredientId: TOFU_ID, quantity: 100, unit: 'g', note: null },
        { ingredientId: TOFU_ID, quantity: null, unit: null, note: null },
      ],
    });
    await createRecipe(mongo, {
      id: RECIPE_2,
      title: 'Món 2',
      servings: 1,
      ingredients: [
        { ingredientId: SALT_ID, quantity: null, unit: null, note: 'ít' },
        { ingredientId: TOFU_ID, quantity: 1, unit: 'G', note: null },
        { ingredientId: TOFU_DUP_ID, quantity: 50, unit: 'g', note: null },
        { ingredientId: ORPHAN_ING_ID, quantity: 20, unit: 'g', note: null },
      ],
    });
    await createRecipe(mongo, {
      id: RECIPE_3,
      title: 'Món 3',
      servings: 1,
      ingredients: [
        { ingredientId: TOFU_ID, quantity: 2, unit: 'G', note: null },
      ],
    });

    await addEntry(Weekday.MON, MealSection.BREAKFAST, RECIPE_1, 0);
    await addEntry(Weekday.MON, MealSection.BREAKFAST, RECIPE_2, 1);
    await addEntry(Weekday.MON, MealSection.BREAKFAST, RECIPE_3, 2);
    // Orphan recipe entry
    await addEntry(
      Weekday.MON,
      MealSection.DINNER,
      'd1a2d3e4-0000-4000-8000-000000000099',
      0,
    );

    const result = await service.get(USER_ID, { days: [Weekday.MON] });

    const salt = result.items.find((item) => item.ingredientId === SALT_ID);
    expect(salt).toMatchObject({
      unit: null,
      knownQuantity: null,
      hasUnknownQuantity: true,
    });
    expect(salt?.contributions).toHaveLength(2);

    const tofuLowerG = result.items.filter(
      (item) => item.ingredientId === TOFU_ID && item.unit === 'g',
    );
    const tofuUpperG = result.items.filter(
      (item) => item.ingredientId === TOFU_ID && item.unit === 'G',
    );
    expect(tofuLowerG).toHaveLength(1);
    expect(tofuLowerG[0].knownQuantity).toBe('100.00');
    expect(tofuUpperG).toHaveLength(1);
    expect(tofuUpperG[0].knownQuantity).toBe('3.00');

    expect(
      result.items.find((item) => item.ingredientId === ORPHAN_ING_ID),
    ).toBeUndefined();
  });
  describe('weeks', () => {
    const WEDNESDAY = new Date('2026-11-18T05:00:00Z');

    const tofuRecipe = () =>
      createRecipe(mongo, {
        id: RECIPE_1,
        title: 'Đậu hũ sốt cà',
        servings: 2,
        ingredients: [
          { ingredientId: TOFU_ID, quantity: 1, unit: 'g', note: null },
        ],
      });

    it('lists only the dishes of the week asked for', async () => {
      await tofuRecipe();
      await addEntry(Weekday.MON, MealSection.LUNCH, RECIPE_1);
      await entries().create({
        _id: randomUUID(),
        userId: USER_ID,
        weekStart: NEXT_WEEK,
        day: Weekday.MON,
        section: MealSection.LUNCH,
        recipeId: RECIPE_1,
        position: 0,
      });

      const thisWeek = await service.get(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON],
      });
      const nextWeek = await service.get(USER_ID, {
        weekStart: NEXT_WEEK,
        days: [Weekday.MON],
      });
      const empty = await service.get(USER_ID, {
        weekStart: '2026-11-30',
        days: [Weekday.MON],
      });

      expect(thisWeek.items[0].knownQuantity).toBe('1.00');
      expect(nextWeek.weekStart).toBe(NEXT_WEEK);
      expect(nextWeek.items[0].knownQuantity).toBe('1.00');
      expect(empty.items).toEqual([]);
    });

    it('defaults to the current week', async () => {
      await tofuRecipe();
      await addEntry(Weekday.MON, MealSection.LUNCH, RECIPE_1);

      const result = await service.get(USER_ID, { days: [Weekday.MON] });

      expect(result.weekStart).toBe(WEEK);
      expect(result.items).toHaveLength(1);
    });

    it('leaves out days before today', async () => {
      await tofuRecipe();
      await addEntry(Weekday.MON, MealSection.LUNCH, RECIPE_1);
      await addEntry(Weekday.THU, MealSection.LUNCH, RECIPE_1);
      vi.setSystemTime(WEDNESDAY);

      const result = await service.get(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON, Weekday.THU],
      });

      expect(result.days).toEqual([Weekday.THU]);
      expect(result.items[0].contributions.map(({ day }) => day)).toEqual([
        Weekday.THU,
      ]);
    });

    it('is empty for a week that is over', async () => {
      await tofuRecipe();
      await addEntry(Weekday.MON, MealSection.LUNCH, RECIPE_1);
      vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));

      const result = await service.get(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON],
      });

      expect(result).toMatchObject({ days: [], items: [] });
    });

    it('refuses a week too far ahead', async () => {
      await expect(
        service.get(USER_ID, { weekStart: '2026-12-21', days: [Weekday.MON] }),
      ).rejects.toMatchObject({ code: 'MEAL_WEEK_OUT_OF_RANGE' });
    });
  });
});
