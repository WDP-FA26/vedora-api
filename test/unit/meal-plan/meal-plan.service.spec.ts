import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
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
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import {
  type IncompatibilityRule,
  type IngredientGroup,
  type MealPlanEntry,
  MealSection,
  RecipeTag,
  Weekday,
} from '../../../src/mongo/models.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { DietaryService } from '../../../src/recipes/dietary.service.js';
import { IncompatibilityRulesService } from '../../../src/recipes/incompatibility-rules.service.js';
import { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const RICE_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const TOFU_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000002';
const RICE_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000003';
const RULE_ID = 'c1a2d3e4-0000-4000-8000-000000000001';
const REASON = 'Oxalat cản hấp thu canxi';
const WEEK = '2026-11-16';
const NEXT_WEEK = '2026-11-23';
// 00:30 on Monday 2026-11-16 in the app time zone, so every day is still editable.
const MONDAY_MORNING = new Date('2026-11-15T17:30:00Z');

describe('MealPlanService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: MealPlanService;

  const entries = () => mongo.connection.model<MealPlanEntry>('MealPlanEntry');
  const users = () => mongo.connection.model('User');
  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');
  const ingredients = () => mongo.connection.model('Ingredient');
  const rules = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');

  type ChangedDays = Awaited<ReturnType<MealPlanService['editPlan']>>['days'];

  /** The dishes of one slot in a change: after (`recipes`) or before (`previous`). */
  const changedIds = (
    days: ChangedDays,
    day: Weekday,
    section: MealSection,
    side: 'recipes' | 'previous' = 'recipes',
  ): string[] => {
    const found = days.find((item) => item.day === day);
    const slot = found?.sections.find((item) => item.section === section);
    if (!slot) return [];
    return slot[side].map(({ id }) => id);
  };

  /** The saved dishes of one slot. */
  const savedIds = async (
    weekStart: string,
    day: Weekday,
    section: MealSection,
  ): Promise<string[]> => {
    const rows = await entries()
      .find({ userId: USER_ID, weekStart, day, section })
      .sort({ position: 1 })
      .exec();
    return rows.map(({ recipeId }) => recipeId);
  };

  const saved = (
    day: Weekday,
    section: MealSection,
    recipeId: string,
  ): Promise<unknown> =>
    entries().create({
      _id: randomUUID(),
      userId: USER_ID,
      weekStart: WEEK,
      day,
      section,
      recipeId,
      position: 0,
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: MONDAY_MORNING });
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
    vi.setSystemTime(MONDAY_MORNING);
    for (const collection of [
      'meal_plan_week_entries',
      'recipes',
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
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
    vi.useRealTimers();
    await dropTestDatabase(app);
    await app.close();
  });

  it('does not mix up two meals of one day', async () => {
    const { problems } = await service.preview(USER_ID, WEEK, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE],
        dinner: [SPINACH_RECIPE],
        others: [],
      },
    ]);

    expect(problems).toEqual([]);
  });

  it('flags incompatible ingredients in one meal', async () => {
    const { problems } = await service.preview(USER_ID, WEEK, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE, SPINACH_RECIPE],
        dinner: [],
        others: [],
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
    const { problems, days } = await service.preview(USER_ID, WEEK, [
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

    const { problems } = await service.preview(USER_ID, WEEK, [
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

  it('shows an avoided recipe to the assistant but keeps it out of the plan', async () => {
    await users().updateOne(
      { _id: USER_ID },
      { $set: { avoidedIngredientIds: [TOFU_ID] } },
    );

    const recipe = await service.recipeInstructions(USER_ID, TOFU_RECIPE);
    expect(recipe).toMatchObject({
      id: TOFU_RECIPE,
      avoidedIngredients: ['Đậu hũ'],
    });

    const attempt = await service.editPlan(USER_ID, WEEK, [
      {
        op: 'set',
        day: Weekday.WED,
        section: MealSection.DINNER,
        recipeIds: [TOFU_RECIPE],
      },
    ]);
    expect(attempt.applied).toBe(false);
    expect(attempt.problems[0]?.code).toBe('AVOIDED_INGREDIENT');
    expect(await entries().countDocuments({ userId: USER_ID })).toBe(0);

    const filled = await service.fillPlan(USER_ID, {
      weekStart: WEEK,
      days: [Weekday.WED],
      sections: [MealSection.DINNER],
      onlyEmpty: false,
      candidateIds: [TOFU_RECIPE],
    });
    expect(
      changedIds(filled.days, Weekday.WED, MealSection.DINNER),
    ).not.toContain(TOFU_RECIPE);
    expect(await savedIds(WEEK, Weekday.WED, MealSection.DINNER)).not.toContain(
      TOFU_RECIPE,
    );
  });

  it('lets a dish be removed from a day that already clashes', async () => {
    await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);
    await saved(Weekday.MON, MealSection.DINNER, SPINACH_RECIPE);
    await saved(Weekday.MON, MealSection.OTHER, RICE_RECIPE);

    const { problems, days } = await service.preview(USER_ID, WEEK, [
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

    const { problems } = await service.preview(USER_ID, WEEK, [
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

  it('saves a day with incompatible dishes and reports the clash as a warning', async () => {
    const plan = await service.apply(USER_ID, WEEK, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [TOFU_RECIPE, SPINACH_RECIPE],
        dinner: [],
        others: [],
      },
    ]);

    expect(await entries().countDocuments()).toBe(2);
    expect(plan.problems).toEqual([
      expect.objectContaining({ code: 'DAY_CONFLICT', day: Weekday.MON }),
    ]);
  });

  it('saves nothing when a day has a dish that does not exist', async () => {
    await expect(
      service.apply(USER_ID, WEEK, [
        {
          day: Weekday.MON,
          breakfast: [],
          lunch: [TOFU_RECIPE],
          dinner: [],
          others: [randomUUID()],
        },
      ]),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(await entries().countDocuments()).toBe(0);
  });

  it('replaces the listed days only, keeping the order', async () => {
    await saved(Weekday.WED, MealSection.LUNCH, SPINACH_RECIPE);

    await service.apply(USER_ID, WEEK, [
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

  it('returns all 7 days in find() and reports problems on the saved timetable', async () => {
    await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);
    await saved(Weekday.MON, MealSection.LUNCH, SPINACH_RECIPE);
    // Orphan entry pointing to non-existent recipe should be skipped
    await saved(
      Weekday.TUE,
      MealSection.BREAKFAST,
      'd1a2d3e4-0000-4000-8000-000000000099',
    );

    const plan = await service.find(USER_ID, WEEK);

    expect(plan.days).toHaveLength(7);
    expect(plan.days[0].day).toBe(Weekday.MON);
    expect(plan.days[0].sections.map((s) => s.section)).toEqual([
      MealSection.BREAKFAST,
      MealSection.LUNCH,
      MealSection.DINNER,
      MealSection.OTHER,
    ]);
    expect(plan.days[0].sections[1].recipes[0]).toMatchObject({
      id: TOFU_RECIPE,
      title: 'Đậu hũ sốt cà',
      ingredients: [{ name: 'Đậu hũ', quantity: null, unit: null, note: null }],
    });
    expect(plan.days[1].sections[0].recipes).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0].code).toBe('DAY_CONFLICT');
  });

  it('clears a day when empty sections are applied and rejects apply for a missing user', async () => {
    await saved(Weekday.MON, MealSection.LUNCH, RICE_RECIPE);

    const updated = await service.apply(USER_ID, WEEK, [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [],
        dinner: [],
        others: [],
      },
    ]);
    expect(updated.days[0].sections.every((s) => s.recipes.length === 0)).toBe(
      true,
    );
    expect(await entries().countDocuments({ userId: USER_ID })).toBe(0);

    await expect(
      service.apply('4a1e32e4-e18e-4dd7-8b4a-246ef2113fff', WEEK, [
        {
          day: Weekday.MON,
          breakfast: [RICE_RECIPE],
          lunch: [],
          dinner: [],
          others: [],
        },
      ]),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('flags avoided recipes after the safe ones and filters internal conflicts and search query', async () => {
    const groupId = 'b1a2d3e4-0000-4000-8000-000000000001';
    await groups().create({
      _id: groupId,
      name: 'Nhóm đậu',
      dietary: true,
      ingredientIds: [TOFU_ID],
    });
    await users().updateOne(
      { _id: USER_ID },
      { $set: { avoidedGroupIds: [groupId] } },
    );
    await ingredients().updateOne(
      { _id: RICE_ID },
      { $set: { aliases: ['brown rice'] } },
    );
    const conflictRecipeId = 'd1a2d3e4-0000-4000-8000-000000000004';
    await createRecipe(
      mongo,
      {
        id: conflictRecipeId,
        title: 'Canh kỵ nhau',
        prepMinutes: null,
        cookMinutes: null,
      },
      [TOFU_ID, SPINACH_ID],
    );
    const noTimeRecipeId = 'd1a2d3e4-0000-4000-8000-000000000005';
    await createRecipe(
      mongo,
      {
        id: noTimeRecipeId,
        title: 'Canh rau đơn giản',
        description: 'Món thanh đạm',
        prepMinutes: null,
        cookMinutes: null,
      },
      [SPINACH_ID],
    );

    const allSafe = await service.suggestions(USER_ID, undefined);
    expect(allSafe.map((r) => r.id)).toEqual(
      expect.arrayContaining([RICE_RECIPE, noTimeRecipeId]),
    );
    // Still searchable so the assistant can talk about it, but flagged and last.
    expect(allSafe.at(-1)).toMatchObject({
      id: TOFU_RECIPE,
      avoidedIngredients: ['Đậu hũ'],
    });
    expect(allSafe.filter((r) => r.avoidedIngredients.length > 0)).toHaveLength(
      1,
    );
    expect(allSafe.map((r) => r.id)).not.toContain(conflictRecipeId);
    expect(allSafe.find((r) => r.id === noTimeRecipeId)?.minutes).toBeNull();
    expect(allSafe.find((r) => r.id === RICE_RECIPE)?.minutes).toBe(15);

    const byAlias = await service.suggestions(USER_ID, 'brown rice');
    expect(byAlias.map((r) => r.id)).toEqual([RICE_RECIPE]);

    const byDescription = await service.suggestions(USER_ID, 'thanh đạm');
    expect(byDescription.map((r) => r.id)).toEqual([noTimeRecipeId]);

    const byIngredient = await service.suggestions(USER_ID, 'Rau bina');
    expect(byIngredient.map((r) => r.id)).toEqual(
      expect.arrayContaining([SPINACH_RECIPE, noTimeRecipeId]),
    );
    expect(byIngredient).toHaveLength(2);
  });

  describe('assistant changes (fillPlan, editPlan)', () => {
    it('fillPlan pins specific recipeIds in a slot, fills the rest and saves', async () => {
      const phoId = 'd1a2d3e4-0000-4000-8000-000000000010';
      await createRecipe(
        mongo,
        {
          id: phoId,
          title: 'Phở chay',
          prepMinutes: 10,
          cookMinutes: 15,
        },
        [TOFU_ID],
      );

      const result = await service.fillPlan(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.WED],
        sections: [
          MealSection.BREAKFAST,
          MealSection.LUNCH,
          MealSection.DINNER,
        ],
        onlyEmpty: false,
        pinned: [
          {
            day: Weekday.WED,
            section: MealSection.LUNCH,
            recipeIds: [phoId],
          },
        ],
      });

      expect(result.applied).toBe(true);
      expect(result.problems).toEqual([]);
      expect(result.days.map(({ day }) => day)).toEqual([Weekday.WED]);
      expect(changedIds(result.days, Weekday.WED, MealSection.LUNCH)).toEqual([
        phoId,
      ]);
      expect(
        changedIds(result.days, Weekday.WED, MealSection.LUNCH, 'previous'),
      ).toEqual([]);
      expect(await savedIds(WEEK, Weekday.WED, MealSection.LUNCH)).toEqual([
        phoId,
      ]);
    });

    it('editPlan returns each changed day with all four sections, before and after', async () => {
      await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);

      const result = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.DINNER,
          recipeIds: [RICE_RECIPE],
        },
      ]);

      expect(result.applied).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.days).toHaveLength(1);
      expect(result.days[0].sections.map(({ section }) => section)).toEqual([
        MealSection.BREAKFAST,
        MealSection.LUNCH,
        MealSection.DINNER,
        MealSection.OTHER,
      ]);
      const { days } = result;
      expect(changedIds(days, Weekday.MON, MealSection.LUNCH)).toEqual([
        TOFU_RECIPE,
      ]);
      expect(
        changedIds(days, Weekday.MON, MealSection.LUNCH, 'previous'),
      ).toEqual([TOFU_RECIPE]);
      expect(changedIds(days, Weekday.MON, MealSection.DINNER)).toEqual([
        RICE_RECIPE,
      ]);
      expect(
        changedIds(days, Weekday.MON, MealSection.DINNER, 'previous'),
      ).toEqual([]);
      expect(await savedIds(WEEK, Weekday.MON, MealSection.DINNER)).toEqual([
        RICE_RECIPE,
      ]);
      expect(await savedIds(WEEK, Weekday.MON, MealSection.LUNCH)).toEqual([
        TOFU_RECIPE,
      ]);
    });

    it('editPlan saves a DAY_CONFLICT and lists it, so a later edit can fix it', async () => {
      const clash = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.WED,
          section: MealSection.DINNER,
          recipeIds: [SPINACH_RECIPE, TOFU_RECIPE],
        },
      ]);

      expect(clash.applied).toBe(true);
      expect(clash.problems.map(({ code }) => code)).toEqual(['DAY_CONFLICT']);
      expect(await savedIds(WEEK, Weekday.WED, MealSection.DINNER)).toEqual([
        SPINACH_RECIPE,
        TOFU_RECIPE,
      ]);

      const resolved = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.WED,
          section: MealSection.DINNER,
          recipeIds: [SPINACH_RECIPE, RICE_RECIPE],
        },
      ]);
      expect(resolved.applied).toBe(true);
      expect(resolved.problems).toEqual([]);
      expect(
        changedIds(resolved.days, Weekday.WED, MealSection.DINNER, 'previous'),
      ).toEqual([SPINACH_RECIPE, TOFU_RECIPE]);
      expect(await savedIds(WEEK, Weekday.WED, MealSection.DINNER)).toEqual([
        SPINACH_RECIPE,
        RICE_RECIPE,
      ]);
    });

    it('editPlan with an unknown recipe saves nothing, not even its valid operations', async () => {
      await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);

      const result = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeIds: [RICE_RECIPE],
        },
        {
          op: 'set',
          day: Weekday.TUE,
          section: MealSection.LUNCH,
          recipeIds: ['d1a2d3e4-0000-4000-8000-000000000099'],
        },
      ]);

      expect(result.applied).toBe(false);
      expect(result.problems.map(({ code }) => code)).toEqual([
        'UNKNOWN_RECIPE',
      ]);
      expect(await savedIds(WEEK, Weekday.MON, MealSection.LUNCH)).toEqual([
        TOFU_RECIPE,
      ]);
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(1);
    });

    it('editPlan reports applied: false with no days when nothing changes', async () => {
      const cleared = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'clear',
          day: Weekday.FRI,
          section: MealSection.DINNER,
        },
      ]);

      expect(cleared).toEqual({
        weekStart: WEEK,
        days: [],
        problems: [],
        applied: false,
        errors: [],
      });
    });

    it('filters suggestions by multiple tags and exclude words', async () => {
      const noodleId = 'd1a2d3e4-0000-4000-8000-000000000020';
      const soupId = 'd1a2d3e4-0000-4000-8000-000000000021';
      const friedId = 'd1a2d3e4-0000-4000-8000-000000000022';
      await createRecipe(
        mongo,
        { id: noodleId, title: 'Phở chay', tag: RecipeTag.NOODLES },
        [RICE_ID],
      );
      await createRecipe(
        mongo,
        { id: soupId, title: 'Canh bí đỏ', tag: RecipeTag.SOUP },
        [RICE_ID],
      );
      await createRecipe(
        mongo,
        { id: friedId, title: 'Bánh chiên giòn', tag: RecipeTag.SNACK },
        [RICE_ID],
      );

      const multiTag = await service.suggestions(USER_ID, undefined, {
        tags: [RecipeTag.NOODLES, RecipeTag.SOUP],
      });
      expect(multiTag.map((r) => r.id)).toEqual([soupId, noodleId]);

      const withoutFried = await service.suggestions(USER_ID, undefined, {
        exclude: ['chiên'],
      });
      expect(withoutFried.map((r) => r.id)).not.toContain(friedId);
    });
  });
  describe('weeks', () => {
    // 12:00 on Wednesday 2026-11-18 in the app time zone.
    const WEDNESDAY = new Date('2026-11-18T05:00:00Z');

    const day = (
      name: Weekday,
      lunch: string[] = [],
    ): {
      day: Weekday;
      breakfast: string[];
      lunch: string[];
      dinner: string[];
      others: string[];
    } => ({ day: name, breakfast: [], lunch, dinner: [], others: [] });

    const lunchIds = (
      plan: Awaited<ReturnType<MealPlanService['find']>>,
      name: Weekday,
    ): string[] => {
      const found = plan.days.find((item) => item.day === name);
      const lunch = found?.sections.find(
        ({ section }) => section === MealSection.LUNCH,
      );
      return (lunch?.recipes ?? []).map(({ id }) => id);
    };

    it('keeps the same dish in the same slot of two weeks', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
      await service.apply(USER_ID, NEXT_WEEK, [
        day(Weekday.MON, [TOFU_RECIPE]),
      ]);

      expect(lunchIds(await service.find(USER_ID, WEEK), Weekday.MON)).toEqual([
        TOFU_RECIPE,
      ]);
      expect(
        lunchIds(await service.find(USER_ID, NEXT_WEEK), Weekday.MON),
      ).toEqual([TOFU_RECIPE]);
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(2);
    });

    it('changes only the week it was saved for', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
      await service.apply(USER_ID, NEXT_WEEK, [
        day(Weekday.MON, [RICE_RECIPE]),
      ]);

      expect(lunchIds(await service.find(USER_ID, WEEK), Weekday.MON)).toEqual([
        TOFU_RECIPE,
      ]);
      expect(
        lunchIds(await service.find(USER_ID, NEXT_WEEK), Weekday.MON),
      ).toEqual([RICE_RECIPE]);
    });

    it('leaves a week nobody planned empty instead of inheriting another', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);

      const plan = await service.find(USER_ID, NEXT_WEEK);

      expect(
        plan.days.every(({ sections }) =>
          sections.every(({ recipes }) => recipes.length === 0),
        ),
      ).toBe(true);
    });

    it('describes the week: dates, editable days and how far to browse', async () => {
      vi.setSystemTime(WEDNESDAY);
      await service.apply(USER_ID, WEEK, [day(Weekday.THU, [TOFU_RECIPE])]);

      const plan = await service.find(USER_ID);

      expect(plan).toMatchObject({
        weekStart: WEEK,
        currentWeekStart: WEEK,
        today: '2026-11-18',
        maxWeekStart: '2026-12-14',
        minWeekStart: WEEK,
        editable: true,
      });
      expect(plan.days.map(({ date }) => date)).toEqual([
        '2026-11-16',
        '2026-11-17',
        '2026-11-18',
        '2026-11-19',
        '2026-11-20',
        '2026-11-21',
        '2026-11-22',
      ]);
      expect(plan.days.map(({ editable }) => editable)).toEqual([
        false,
        false,
        true,
        true,
        true,
        true,
        true,
      ]);
    });

    it('treats the day as over at midnight in the app time zone', async () => {
      // 23:30 on Tuesday in Bangkok is still Tuesday; 00:30 Wednesday is not.
      vi.setSystemTime(new Date('2026-11-17T16:30:00Z'));
      const tuesday = await service.find(USER_ID);
      vi.setSystemTime(new Date('2026-11-17T17:30:00Z'));
      const wednesday = await service.find(USER_ID);

      expect(tuesday.today).toBe('2026-11-17');
      expect(tuesday.days[1].editable).toBe(true);
      expect(wednesday.today).toBe('2026-11-18');
      expect(wednesday.days[1].editable).toBe(false);
    });

    it('refuses to change a day before today', async () => {
      vi.setSystemTime(WEDNESDAY);

      const error = await service
        .apply(USER_ID, WEEK, [day(Weekday.TUE, [TOFU_RECIPE])])
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StateConflictException);
      expect(error).toMatchObject({
        code: 'MEAL_DAY_LOCKED',
        details: { days: [Weekday.TUE], today: '2026-11-18' },
      });
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(0);
    });

    it('editPlan reports DAY_PASSED for a slot before today and saves the rest', async () => {
      vi.setSystemTime(WEDNESDAY);

      const result = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.TUE,
          section: MealSection.DINNER,
          recipeIds: [RICE_RECIPE],
        },
        {
          op: 'move',
          from: { day: Weekday.MON, section: MealSection.LUNCH },
          to: { day: Weekday.FRI, section: MealSection.LUNCH },
          recipeId: RICE_RECIPE,
        },
        {
          op: 'set',
          day: Weekday.FRI,
          section: MealSection.DINNER,
          recipeIds: [RICE_RECIPE],
        },
      ]);

      expect(result.errors).toEqual([
        'DAY_PASSED: set TUE DINNER is on a day before today that cannot change',
        'DAY_PASSED: move touches MON, a day before today that cannot change',
      ]);
      expect(result.days.map(({ day: changed }) => changed)).toEqual([
        Weekday.FRI,
      ]);
      expect(result.applied).toBe(true);
      expect(await savedIds(WEEK, Weekday.FRI, MealSection.DINNER)).toEqual([
        RICE_RECIPE,
      ]);
      expect(await savedIds(WEEK, Weekday.TUE, MealSection.DINNER)).toEqual([]);
    });

    it('refuses to preview a day before today', async () => {
      vi.setSystemTime(WEDNESDAY);

      await expect(
        service.preview(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]),
      ).rejects.toMatchObject({ code: 'MEAL_DAY_LOCKED' });
    });

    it('refuses to change a week that is over, while still showing it', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
      vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));

      await expect(
        service.apply(USER_ID, WEEK, [day(Weekday.MON, [RICE_RECIPE])]),
      ).rejects.toMatchObject({ code: 'MEAL_DAY_LOCKED' });
      const plan = await service.find(USER_ID, WEEK);

      expect(plan.editable).toBe(false);
      expect(plan.minWeekStart).toBe(WEEK);
      expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
    });

    it('keeps the dishes of a day that passed, and does not report their problems', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
      vi.setSystemTime(WEDNESDAY);

      const plan = await service.find(USER_ID, WEEK);

      expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
      expect(plan.days[0].editable).toBe(false);
    });

    it('allows the last week ahead and refuses the one after it', async () => {
      const last = '2026-12-14';
      await service.apply(USER_ID, last, [day(Weekday.MON, [TOFU_RECIPE])]);

      await expect(
        service.apply(USER_ID, '2026-12-21', [day(Weekday.MON, [TOFU_RECIPE])]),
      ).rejects.toMatchObject({ code: 'MEAL_WEEK_OUT_OF_RANGE' });
      await expect(service.find(USER_ID, '2026-12-21')).rejects.toMatchObject({
        code: 'MEAL_WEEK_OUT_OF_RANGE',
      });
      expect(lunchIds(await service.find(USER_ID, last), Weekday.MON)).toEqual([
        TOFU_RECIPE,
      ]);
    });

    it('editPlan changes only the week it names', async () => {
      await service.editPlan(USER_ID, NEXT_WEEK, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeIds: [TOFU_RECIPE],
        },
      ]);

      expect(lunchIds(await service.find(USER_ID, WEEK), Weekday.MON)).toEqual(
        [],
      );
      expect(
        lunchIds(await service.find(USER_ID, NEXT_WEEK), Weekday.MON),
      ).toEqual([TOFU_RECIPE]);
    });

    it('does not let editPlan touch a day before today', async () => {
      vi.setSystemTime(WEDNESDAY);

      const result = await service.editPlan(USER_ID, WEEK, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeIds: [TOFU_RECIPE],
        },
        {
          op: 'set',
          day: Weekday.THU,
          section: MealSection.LUNCH,
          recipeIds: [RICE_RECIPE],
        },
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.days.map(({ day: name }) => name)).toEqual([Weekday.THU]);
      expect(await savedIds(WEEK, Weekday.MON, MealSection.LUNCH)).toEqual([]);
      expect(await savedIds(WEEK, Weekday.THU, MealSection.LUNCH)).toEqual([
        RICE_RECIPE,
      ]);
    });

    it('restoreDays puts days back as they were', async () => {
      await service.apply(USER_ID, WEEK, [
        day(Weekday.WED, [TOFU_RECIPE]),
        day(Weekday.THU, [RICE_RECIPE]),
      ]);

      const result = await service.restoreDays(USER_ID, WEEK, [
        day(Weekday.WED, [RICE_RECIPE]),
        day(Weekday.THU),
      ]);

      expect(result).toEqual({
        restored: [Weekday.WED, Weekday.THU],
        skipped: [],
        droppedDishes: 0,
      });
      const plan = await service.find(USER_ID, WEEK);
      expect(lunchIds(plan, Weekday.WED)).toEqual([RICE_RECIPE]);
      expect(lunchIds(plan, Weekday.THU)).toEqual([]);
    });

    it('restoreDays leaves out a dish that no longer exists and restores the rest', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.WED, [TOFU_RECIPE])]);
      const deletedRecipe = randomUUID();

      const result = await service.restoreDays(USER_ID, WEEK, [
        day(Weekday.WED, [RICE_RECIPE, deletedRecipe]),
      ]);

      expect(result).toEqual({
        restored: [Weekday.WED],
        skipped: [],
        droppedDishes: 1,
      });
      const plan = await service.find(USER_ID, WEEK);
      expect(lunchIds(plan, Weekday.WED)).toEqual([RICE_RECIPE]);
    });

    it('restoreDays skips days that have passed and restores the rest', async () => {
      await service.apply(USER_ID, WEEK, [
        day(Weekday.MON, [TOFU_RECIPE]),
        day(Weekday.THU, [TOFU_RECIPE]),
      ]);
      vi.setSystemTime(WEDNESDAY);

      const result = await service.restoreDays(USER_ID, WEEK, [
        day(Weekday.MON),
        day(Weekday.THU, [RICE_RECIPE]),
      ]);

      expect(result).toEqual({
        restored: [Weekday.THU],
        skipped: [Weekday.MON],
        droppedDishes: 0,
      });
      const plan = await service.find(USER_ID, WEEK);
      expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
      expect(lunchIds(plan, Weekday.THU)).toEqual([RICE_RECIPE]);
    });

    it('restoreDays writes nothing when every day has passed', async () => {
      await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
      vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));

      const result = await service.restoreDays(USER_ID, WEEK, [
        day(Weekday.MON),
      ]);

      expect(result).toEqual({
        restored: [],
        skipped: [Weekday.MON],
        droppedDishes: 0,
      });
      expect(await savedIds(WEEK, Weekday.MON, MealSection.LUNCH)).toEqual([
        TOFU_RECIPE,
      ]);
    });

    it('autoBalancePlan changes nothing when every requested day has passed', async () => {
      vi.setSystemTime(WEDNESDAY);

      const result = await service.autoBalancePlan(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON, Weekday.TUE],
        targetCalories: 1800,
      });

      expect(result).toEqual({
        weekStart: WEEK,
        days: [],
        problems: [],
        applied: false,
        filled: 0,
        targetCalories: 1800,
      });
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(0);
    });

    it('fillPlan skips passed days and saves only days from today on', async () => {
      vi.setSystemTime(WEDNESDAY);

      const result = await service.fillPlan(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON, Weekday.TUE, Weekday.WED],
        sections: [MealSection.LUNCH],
        onlyEmpty: true,
      });

      expect(result.days.map(({ day: name }) => name)).toEqual([Weekday.WED]);
      expect(result.applied).toBe(true);
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(1);
      expect(await savedIds(WEEK, Weekday.WED, MealSection.LUNCH)).toHaveLength(
        1,
      );
    });

    it('fillPlan saves nothing for a week that is over', async () => {
      vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));

      const result = await service.fillPlan(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON],
        sections: [MealSection.LUNCH],
        onlyEmpty: true,
      });

      expect(result).toMatchObject({ days: [], filled: 0, applied: false });
      expect(await entries().countDocuments({ userId: USER_ID })).toBe(0);
    });

    it('generates only for days from today on', async () => {
      vi.setSystemTime(WEDNESDAY);

      const none = await service.generate(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.MON, Weekday.TUE],
        sections: [MealSection.LUNCH],
        onlyEmpty: true,
      });
      const some = await service.generate(USER_ID, {
        weekStart: WEEK,
        days: [Weekday.TUE, Weekday.WED],
        sections: [MealSection.LUNCH],
        onlyEmpty: true,
      });

      expect(none).toEqual({ weekStart: WEEK, days: [], problems: [] });
      expect(some.days.map(({ day: name }) => name)).toEqual([Weekday.WED]);
    });

    describe('copyWeek', () => {
      it('copies one week onto an empty one', async () => {
        await service.apply(USER_ID, WEEK, [
          day(Weekday.MON, [TOFU_RECIPE]),
          day(Weekday.FRI, [RICE_RECIPE]),
        ]);

        const plan = await service.copyWeek(USER_ID, WEEK, NEXT_WEEK, false);

        expect(plan.weekStart).toBe(NEXT_WEEK);
        expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
        expect(lunchIds(plan, Weekday.FRI)).toEqual([RICE_RECIPE]);
        expect(
          lunchIds(await service.find(USER_ID, WEEK), Weekday.MON),
        ).toEqual([TOFU_RECIPE]);
      });

      it('refuses a target that already has dishes, and changes nothing', async () => {
        await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
        await service.apply(USER_ID, NEXT_WEEK, [
          day(Weekday.TUE, [RICE_RECIPE]),
        ]);

        await expect(
          service.copyWeek(USER_ID, WEEK, NEXT_WEEK, false),
        ).rejects.toMatchObject({ code: 'MEAL_WEEK_NOT_EMPTY' });

        const plan = await service.find(USER_ID, NEXT_WEEK);
        expect(lunchIds(plan, Weekday.MON)).toEqual([]);
        expect(lunchIds(plan, Weekday.TUE)).toEqual([RICE_RECIPE]);
      });

      it('replaces the target when asked to overwrite', async () => {
        await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
        await service.apply(USER_ID, NEXT_WEEK, [
          day(Weekday.TUE, [RICE_RECIPE]),
        ]);

        const plan = await service.copyWeek(USER_ID, WEEK, NEXT_WEEK, true);

        expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
        expect(lunchIds(plan, Weekday.TUE)).toEqual([]);
      });

      it('leaves the days before today of the target week alone', async () => {
        await service.apply(USER_ID, WEEK, [day(Weekday.MON, [TOFU_RECIPE])]);
        await service.apply(USER_ID, NEXT_WEEK, [
          day(Weekday.MON, [RICE_RECIPE]),
          day(Weekday.THU, [RICE_RECIPE]),
        ]);
        vi.setSystemTime(WEDNESDAY);

        const plan = await service.copyWeek(USER_ID, NEXT_WEEK, WEEK, true);

        expect(lunchIds(plan, Weekday.MON)).toEqual([TOFU_RECIPE]);
        expect(lunchIds(plan, Weekday.THU)).toEqual([RICE_RECIPE]);
      });

      it('refuses to copy a week onto itself', async () => {
        await expect(
          service.copyWeek(USER_ID, WEEK, WEEK, true),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });

      it('refuses a week too far ahead and a week that is over', async () => {
        await expect(
          service.copyWeek(USER_ID, WEEK, '2026-12-21', false),
        ).rejects.toMatchObject({ code: 'MEAL_WEEK_OUT_OF_RANGE' });
        vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));
        await expect(
          service.copyWeek(USER_ID, NEXT_WEEK, WEEK, false),
        ).rejects.toMatchObject({ code: 'MEAL_DAY_LOCKED' });
      });
    });
  });
});
