import { ConflictException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MongoModule } from '../mongo/mongo.module';
import {
  type IncompatibilityRule,
  type MealPlanEntry,
  MealSection,
  Weekday,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { DietaryService } from '../recipes/dietary.service';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service';
import { MealPlanService } from './meal-plan.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const RICE_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const TOFU_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000002';
const RICE_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000003';
const RULE_ID = 'c1a2d3e4-0000-4000-8000-000000000001';
const REASON = 'Oxalat cản hấp thu canxi';

describe('MealPlanService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: MealPlanService;

  const entries = () => mongo.connection.model<MealPlanEntry>('MealPlanEntry');
  const users = () => mongo.connection.model('User');
  const rules = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');

  const saved = (
    day: Weekday,
    section: MealSection,
    recipeId: string,
  ): Promise<unknown> =>
    entries().create({
      _id: randomUUID(),
      userId: USER_ID,
      day,
      section,
      recipeId,
      position: 0,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('mealplan'))],
      providers: [MealPlanService, DietaryService, IncompatibilityRulesService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(MealPlanService);
  });
  beforeEach(async () => {
    for (const collection of [
      'meal_plan_entries',
      'recipes',
      'recipe_ingredients',
      'ingredients',
      'ingredient_groups',
      'ingredient_group_members',
      'incompatibility_rules',
      'users',
    ]) {
      await mongo.db.collection(collection).deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'plan.user' });
    await createIngredient(mongo, { id: TOFU_ID, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: SPINACH_ID, name: 'Rau bina' });
    await createIngredient(mongo, { id: RICE_ID, name: 'Gạo lứt' });
    await createRecipe(
      mongo,
      {
        id: TOFU_RECIPE,
        title: 'Đậu hũ sốt cà',
        prepMinutes: 10,
        cookMinutes: 5,
        steps: ['Nấu'],
      },
      [TOFU_ID],
    );
    await createRecipe(
      mongo,
      {
        id: SPINACH_RECIPE,
        title: 'Canh rau bina',
        prepMinutes: 10,
        cookMinutes: 5,
        steps: ['Nấu'],
      },
      [SPINACH_ID],
    );
    await createRecipe(
      mongo,
      {
        id: RICE_RECIPE,
        title: 'Cơm gạo lứt',
        prepMinutes: 10,
        cookMinutes: 5,
        steps: ['Nấu'],
      },
      [RICE_ID],
    );
    await rules().create({
      _id: RULE_ID,
      aIngredientId: TOFU_ID,
      bIngredientId: SPINACH_ID,
      reason: REASON,
    });
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('rejects incompatible ingredients in two sections of one day', async () => {
    const { problems } = await service.preview(USER_ID, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE],
        dinner: [],
        others: [SPINACH_RECIPE],
      },
    ]);

    expect(problems).toEqual([
      {
        code: 'DAY_CONFLICT',
        day: Weekday.MON,
        recipes: ['Đậu hũ sốt cà', 'Canh rau bina'],
        recipeIds: [TOFU_RECIPE, SPINACH_RECIPE],
        ingredients: ['Đậu hũ', 'Rau bina'],
        reason: REASON,
      },
    ]);
  });

  it('allows incompatible ingredients on different days', async () => {
    const { problems, days } = await service.preview(USER_ID, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE],
        dinner: [],
        others: [],
      },
      {
        day: Weekday.TUE,
        breakfast: [],
        lunch: [SPINACH_RECIPE],
        dinner: [],
        others: [],
      },
    ]);

    expect(problems).toEqual([]);
    expect(days).toHaveLength(2);
  });

  it('rejects a recipe with an ingredient the user avoids', async () => {
    await users().updateOne(
      { _id: USER_ID },
      { $set: { avoidedIngredientIds: [TOFU_ID] } },
    );

    const { problems } = await service.preview(USER_ID, [
      {
        day: Weekday.WED,
        breakfast: [RICE_RECIPE],
        lunch: [],
        dinner: [TOFU_RECIPE],
        others: [],
      },
    ]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: 'AVOIDED_INGREDIENT',
        day: Weekday.WED,
        recipes: ['Đậu hũ sốt cà'],
        recipeIds: [TOFU_RECIPE],
        ingredients: ['Đậu hũ'],
      }),
    ]);
  });

  it('lets a dish be removed from a day that already clashes', async () => {
    await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);
    await saved(Weekday.MON, MealSection.DINNER, SPINACH_RECIPE);
    await saved(Weekday.MON, MealSection.OTHER, RICE_RECIPE);

    const { problems, days } = await service.preview(USER_ID, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE],
        dinner: [],
        others: [SPINACH_RECIPE],
      },
    ]);

    expect(problems).toEqual([]);
    expect(days[0].sections.map(({ previous }) => previous.length)).toEqual([
      0, 1, 1, 1,
    ]);
  });

  it('reports a recipe that does not exist', async () => {
    const missing = 'd1a2d3e4-0000-4000-8000-000000000099';

    const { problems } = await service.preview(USER_ID, [
      {
        day: Weekday.MON,
        breakfast: [RICE_RECIPE],
        lunch: [RICE_RECIPE, missing],
        dinner: [],
        others: [],
      },
    ]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_RECIPE',
        day: Weekday.MON,
        recipes: [],
        recipeIds: [missing],
      }),
    ]);
  });

  it('saves nothing when a day is invalid', async () => {
    await expect(
      service.apply(USER_ID, [
        {
          day: Weekday.MON,
          breakfast: [],
          lunch: [TOFU_RECIPE],
          dinner: [],
          others: [SPINACH_RECIPE],
        },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await entries().countDocuments()).toBe(0);
  });

  it('replaces the listed days only, keeping the order', async () => {
    await saved(Weekday.WED, MealSection.LUNCH, SPINACH_RECIPE);

    await service.apply(USER_ID, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [RICE_RECIPE, TOFU_RECIPE],
        dinner: [],
        others: [],
      },
      {
        day: Weekday.TUE,
        breakfast: [],
        lunch: [],
        dinner: [],
        others: [],
      },
    ]);

    const monday = await entries()
      .find({ userId: USER_ID, day: Weekday.MON })
      .sort({ position: 1 });
    expect(monday.map(({ recipeId }) => recipeId)).toEqual([
      RICE_RECIPE,
      TOFU_RECIPE,
    ]);
    expect(monday[0]).toMatchObject({
      section: MealSection.LUNCH,
      position: 0,
    });
    expect(monday[1]).toMatchObject({
      section: MealSection.LUNCH,
      position: 1,
    });
    const wednesday = await entries().findOne({
      userId: USER_ID,
      day: Weekday.WED,
    });
    expect(wednesday).toMatchObject({ recipeId: SPINACH_RECIPE });
  });
});
