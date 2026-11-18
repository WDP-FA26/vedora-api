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
      'meal_plan_draft_slots',
      'meal_plan_entries',
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
    await dropTestDatabase(app);
    await app.close();
  });

  it('does not mix up two meals of one day', async () => {
    const { problems } = await service.preview(USER_ID, [
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
    const { problems } = await service.preview(USER_ID, [
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

  it('saves a day with incompatible dishes and reports the clash as a warning', async () => {
    const plan = await service.apply(USER_ID, [
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
      service.apply(USER_ID, [
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

  it('returns all 7 days in find() and reports problems on the saved timetable', async () => {
    await saved(Weekday.MON, MealSection.LUNCH, TOFU_RECIPE);
    await saved(Weekday.MON, MealSection.LUNCH, SPINACH_RECIPE);
    // Orphan entry pointing to non-existent recipe should be skipped
    await saved(
      Weekday.TUE,
      MealSection.BREAKFAST,
      'd1a2d3e4-0000-4000-8000-000000000099',
    );

    const plan = await service.find(USER_ID);

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

    const updated = await service.apply(USER_ID, [
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
      service.apply('4a1e32e4-e18e-4dd7-8b4a-246ef2113fff', [
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

  it('returns safe suggestions filtered by dietary profile, internal conflicts, and search query', async () => {
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
    expect(allSafe.map((r) => r.id)).not.toContain(TOFU_RECIPE);
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

  describe('draft operations (fillDraft, editDraft, getDraft, discardDraft)', () => {
    it('fillDraft pins specific recipeIds in a slot and fills the remaining slots', async () => {
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

      const result = await service.fillDraft(USER_ID, {
        days: [Weekday.WED],
        sections: [MealSection.BREAKFAST, MealSection.LUNCH, MealSection.DINNER],
        onlyEmpty: false,
        pinned: [
          {
            day: Weekday.WED,
            section: MealSection.LUNCH,
            recipeIds: [phoId],
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      const wed = result.days.find((d) => d.day === Weekday.WED);
      const sectionIds = (section: MealSection) =>
        wed?.sections
          .find((s) => s.section === section)
          ?.recipes.map((r) => r.id);
      expect(sectionIds(MealSection.LUNCH)).toEqual([phoId]);

      const draft = await service.getDraft(USER_ID);
      expect(draft.days).toHaveLength(1);
      await service.discardDraft(USER_ID);
      expect(await service.getDraft(USER_ID)).toEqual({
        days: [],
        problems: [],
        ok: false,
      });
    });

    it('editDraft keeps DAY_CONFLICT in draft for the agent to resolve without mutating other slots', async () => {
      await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.WED,
          section: MealSection.DINNER,
          recipeIds: [SPINACH_RECIPE],
        },
      ]);

      const clash = await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.WED,
          section: MealSection.DINNER,
          recipeIds: [SPINACH_RECIPE, TOFU_RECIPE],
        },
      ]);

      expect(clash.ok).toBe(false);
      expect(clash.problems[0]?.code).toBe('DAY_CONFLICT');
      const draft = await service.getDraft(USER_ID);
      expect(draft.days).toHaveLength(1);

      const resolved = await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.WED,
          section: MealSection.DINNER,
          recipeIds: [SPINACH_RECIPE, RICE_RECIPE],
        },
      ]);
      expect(resolved.ok).toBe(true);
      expect(resolved.problems).toEqual([]);
      const wed = resolved.days.find((d) => d.day === Weekday.WED);
      const dinner = wed?.sections.find(
        (s) => s.section === MealSection.DINNER,
      );
      expect(dinner?.recipes.map((r) => r.id)).toEqual([
        SPINACH_RECIPE,
        RICE_RECIPE,
      ]);
    });

    it('persists draft on a DAY_CONFLICT inside one meal, but keeps nothing on fatal problems', async () => {
      const clash = await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeIds: [TOFU_RECIPE, SPINACH_RECIPE],
        },
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.DINNER,
          recipeIds: [RICE_RECIPE],
        },
      ]);

      expect(clash.ok).toBe(false);
      expect(clash.problems[0]?.code).toBe('DAY_CONFLICT');
      // Still persisted so fixing one slot keeps the other
      const fixed = await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeIds: [TOFU_RECIPE],
        },
      ]);
      expect(fixed.ok).toBe(true);
      expect(fixed.problems).toEqual([]);

      await service.discardDraft(USER_ID);
      const unknown = await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.TUE,
          section: MealSection.LUNCH,
          recipeIds: ['d1a2d3e4-0000-4000-8000-000000000099'],
        },
      ]);
      expect(unknown.ok).toBe(false);
      expect(unknown.problems[0]?.code).toBe('UNKNOWN_RECIPE');
      expect((await service.getDraft(USER_ID)).days).toEqual([]);
    });

    it('returns ok=true with empty days when editDraft clears draft back to saved plan', async () => {
      await service.editDraft(USER_ID, [
        {
          op: 'set',
          day: Weekday.FRI,
          section: MealSection.DINNER,
          recipeIds: [RICE_RECIPE],
        },
      ]);

      const cleared = await service.editDraft(USER_ID, [
        {
          op: 'clear',
          day: Weekday.FRI,
          section: MealSection.DINNER,
        },
      ]);

      expect(cleared).toEqual({
        days: [],
        problems: [],
        ok: true,
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
});
