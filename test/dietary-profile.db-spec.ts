import { execFileSync } from 'node:child_process';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { DietaryService } from '../src/recipes/dietary.service';
import { IngredientsService } from '../src/recipes/ingredients.service';
import { IncompatibilityRulesService } from '../src/recipes/incompatibility-rules.service';
import { RecipeCatalogService } from '../src/recipes/recipe-catalog.service';
import { RecipeCatalogQueryDto } from '../src/recipes/dto/recipe-catalog.dto';
import { MealPlanService } from '../src/meal-plan/meal-plan.service';
import {
  confirmedDietaryProfile,
  verifiedIngredientSafety,
} from './fixtures/dietary';

describe('Dietary profile with PostgreSQL', () => {
  const schema = 'vedora_dietary_test_' + randomUUID().replaceAll('-', '');
  let prisma: PrismaClient;
  let dietary: DietaryService;
  let ingredients: IngredientsService;
  let catalog: RecipeCatalogService;
  let plan: MealPlanService;
  let userId: string;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const db = prisma as PrismaService;
    dietary = new DietaryService(db);
    ingredients = new IngredientsService(db);
    const rules = new IncompatibilityRulesService(db);
    catalog = new RecipeCatalogService(db, rules, dietary);
    plan = new MealPlanService(db, dietary, rules);
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await prisma.recipe.deleteMany();
    await prisma.ingredientGroup.deleteMany();
    await prisma.ingredient.deleteMany();
    ({ id: userId } = await prisma.user.create({
      data: {
        username: 'dietary.user',
        fullName: 'Dietary User',
        email: 'dietary@example.test',
      },
    }));
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRaw(
        Prisma.sql`DROP SCHEMA ${Prisma.raw('"' + schema + '"')} CASCADE`,
      );
      await prisma.$disconnect();
    }
  });

  const query = (fields: Partial<RecipeCatalogQueryDto> = {}) =>
    Object.assign(new RecipeCatalogQueryDto(), fields);
  const day = (recipeId: string) => ({
    day: 'MON' as const,
    breakfast: [],
    lunch: [recipeId],
    dinner: [],
    others: [],
  });
  async function confirm() {
    return dietary.patch(userId, {
      expectedVersion: (await dietary.find(userId)).version,
      allergyAcknowledgement: 'NONE_DECLARED',
    });
  }
  async function ingredient(
    name: string,
    extra: Prisma.IngredientCreateInput = { name },
  ) {
    return prisma.ingredient.create({
      data: { ...verifiedIngredientSafety, aliases: [], ...extra, name },
    });
  }
  async function recipe(name: string, ingredientId: string) {
    return prisma.recipe.create({
      data: {
        title: name,
        servings: 2,
        steps: ['Cook'],
        ingredients: {
          create: { ingredientId, position: 0, quantity: 100, unit: 'g' },
        },
      },
    });
  }

  it('does not infer allergy confirmation or verified labels from legacy defaults', async () => {
    const profile = await dietary.find(userId);
    expect(profile).toMatchObject({
      dietMode: 'VEGETARIAN',
      allergyAcknowledgement: 'UNCONFIRMED',
      version: 0,
      readyForMealPlanning: false,
      exclusions: [],
    });
    const old = await prisma.ingredient.create({
      data: { name: 'Unknown composite', aliases: [] },
    });
    expect(old).toMatchObject({
      vegetarianStatus: 'UNKNOWN',
      veganStatus: 'UNKNOWN',
      compositionComplete: false,
      allergensComplete: false,
    });
    expect((await dietary.options()).allergenLabels).toContain('MILK');
  });

  it('retains multiple reasons and keeps allergies when switching Vegan to Vegetarian', async () => {
    const milk = await ingredient('Milk', {
      name: 'Milk',
      veganStatus: 'NON_VEGAN',
      animalLabels: ['DAIRY'],
      allergenLabels: ['MILK'],
    });
    const first = await dietary.patch(userId, {
      expectedVersion: 0,
      dietMode: 'VEGAN',
      allergyAcknowledgement: 'DECLARED',
      exclusions: [
        {
          kind: 'INGREDIENT',
          target: milk.id,
          reasons: ['ALLERGY', 'PERSONAL'],
        },
        { kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] },
      ],
    });
    expect(first.exclusions).toContainEqual({
      kind: 'ANIMAL',
      target: 'DAIRY',
      reasons: ['DIET'],
    });
    expect(await prisma.userAvoidedIngredient.count()).toBe(2);
    const next = await dietary.patch(userId, {
      expectedVersion: first.version,
      dietMode: 'VEGETARIAN',
    });
    expect(next.exclusions).toContainEqual({
      kind: 'INGREDIENT',
      target: milk.id,
      reasons: ['ALLERGY', 'PERSONAL'],
    });
    expect(next.exclusions.some((row) => row.reasons.includes('DIET'))).toBe(
      false,
    );
    expect(next.readyForMealPlanning).toBe(true);
  });

  it('rejects an inconsistent allergy acknowledgement atomically', async () => {
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        allergyAcknowledgement: 'DECLARED',
      }),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_ALLERGY_ACKNOWLEDGEMENT' },
    });
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        allergyAcknowledgement: 'NONE_DECLARED',
        exclusions: [
          { kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_ALLERGY_ACKNOWLEDGEMENT' },
    });
    expect((await dietary.find(userId)).version).toBe(0);
    expect(await prisma.userAvoidedLabel.count()).toBe(0);
  });

  it('allows only one of two simultaneous edits with the same expectedVersion', async () => {
    const results = await Promise.allSettled([
      dietary.patch(userId, { expectedVersion: 0, dietMode: 'VEGAN' }),
      dietary.patch(userId, {
        expectedVersion: 0,
        allergyAcknowledgement: 'NONE_DECLARED',
      }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (row) => row.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      response: { code: 'VERSION_CONFLICT' },
    });
    expect((await dietary.find(userId)).version).toBe(1);
  });

  it('validates canonical targets and rolls back unknown references', async () => {
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        exclusions: [
          { kind: 'ALLERGEN', target: 'not-real', reasons: ['PERSONAL'] },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_EXCLUSION_TARGET' } });
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        exclusions: [
          { kind: 'INGREDIENT', target: randomUUID(), reasons: ['PERSONAL'] },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'UNKNOWN_REFERENCE' } });
    expect((await dietary.find(userId)).version).toBe(0);
  });

  it('detects liked ingredients excluded through a group or label', async () => {
    const milk = await ingredient('Milk', {
      name: 'Milk',
      animalLabels: ['DAIRY'],
      veganStatus: 'NON_VEGAN',
    });
    const group = await prisma.ingredientGroup.create({
      data: { name: 'Dairy', members: { create: { ingredientId: milk.id } } },
    });
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        likedIngredientIds: [milk.id],
        exclusions: [
          { kind: 'GROUP', target: group.id, reasons: ['PERSONAL'] },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'CONFLICTING_PREFERENCE' } });
    await expect(
      dietary.patch(userId, {
        expectedVersion: 0,
        likedIngredientIds: [milk.id],
        dietMode: 'VEGAN',
      }),
    ).rejects.toMatchObject({ response: { code: 'CONFLICTING_PREFERENCE' } });
  });

  it('the legacy PUT can replace PERSONAL reasons but cannot erase an allergy', async () => {
    const milk = await ingredient('Milk');
    const profile = await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [
        {
          kind: 'INGREDIENT',
          target: milk.id,
          reasons: ['ALLERGY', 'PERSONAL'],
        },
      ],
    });
    const changed = await dietary.replace(userId, {
      expectedVersion: profile.version,
      ingredientIds: [],
      groupIds: [],
      likedIngredientIds: [],
    });
    expect(changed.exclusions).toEqual([
      { kind: 'INGREDIENT', target: milk.id, reasons: ['ALLERGY'] },
    ]);
    expect(changed.allergyAcknowledgement).toBe('DECLARED');
  });

  it('filters verified Vegan recipes and excludes unknown labels before count/paging', async () => {
    const tofu = await ingredient('Tofu');
    const honey = await ingredient('Honey', {
      name: 'Honey',
      animalLabels: ['HONEY'],
      veganStatus: 'NON_VEGAN',
    });
    const unknown = await ingredient('Unknown Vegan', {
      name: 'Unknown Vegan',
      veganStatus: 'UNKNOWN',
    });
    const verified = await recipe('Tofu dish', tofu.id);
    await recipe('Honey dish', honey.id);
    await recipe('Unknown dish', unknown.id);
    const page = await catalog.list(query({ veganOnly: true, limit: 1 }));
    expect(page.meta.totalItems).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: verified.id,
      veganStatus: 'VERIFIED_VEGAN',
    });
    const profile = await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'NONE_DECLARED',
      dietMode: 'VEGAN',
    });
    expect(profile.readyForMealPlanning).toBe(true);
    expect(
      (await catalog.list(query({ suitableForMe: true }), userId)).items.map(
        (row) => row.id,
      ),
    ).toEqual([verified.id]);
    expect(
      (await plan.suggestions(userId, undefined)).map((row) => row.id),
    ).toEqual([verified.id]);
  });

  it('applies MAY_CONTAIN and incomplete allergen checks consistently in catalog and planner', async () => {
    const clean = await ingredient('Clean rice');
    const mayContain = await ingredient('Trace milk', {
      name: 'Trace milk',
      mayContainAllergens: ['MILK'],
    });
    const unknown = await ingredient('Unknown allergens', {
      name: 'Unknown allergens',
      allergensComplete: false,
    });
    const missingComposition = await ingredient('Missing composition', {
      name: 'Missing composition',
      compositionComplete: false,
      allergensComplete: false,
    });
    const cleanRecipe = await recipe('Clean dish', clean.id);
    const traceRecipe = await recipe('Trace dish', mayContain.id);
    const unknownRecipe = await recipe('Unknown dish', unknown.id);
    const incompleteRecipe = await recipe(
      'Incomplete dish',
      missingComposition.id,
    );
    await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [{ kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] }],
    });
    const page = await catalog.list(
      query({ suitableForMe: true, limit: 1 }),
      userId,
    );
    expect(page.meta.totalItems).toBe(1);
    expect(page.items.map((row) => row.id)).toEqual([cleanRecipe.id]);
    expect(
      (await plan.suggestions(userId, undefined)).map((row) => row.id),
    ).toEqual([cleanRecipe.id]);
    expect(
      (await plan.preview(userId, [day(traceRecipe.id)])).problems,
    ).toMatchObject([{ code: 'AVOIDED_INGREDIENT' }]);
    expect(
      (await plan.preview(userId, [day(unknownRecipe.id)])).problems,
    ).toMatchObject([{ code: 'ALLERGEN_INFORMATION_INCOMPLETE' }]);
    expect(
      (await plan.preview(userId, [day(incompleteRecipe.id)])).problems,
    ).toMatchObject([{ code: 'UNVERIFIED_INGREDIENT' }]);
    await expect(
      plan.apply(userId, [day(traceRecipe.id)]),
    ).rejects.toMatchObject({ response: { code: 'MEAL_PLAN_INVALID' } });
    expect(await prisma.mealPlanEntry.count()).toBe(0);
  });

  it('requires acknowledgement for personalized catalog and meal creation', async () => {
    const dish = await recipe('Rice dish', (await ingredient('Rice')).id);
    expect((await catalog.list(query())).meta.totalItems).toBe(1);
    await expect(
      catalog.list(query({ suitableForMe: true }), userId),
    ).rejects.toMatchObject({
      response: { code: 'DIETARY_PROFILE_INCOMPLETE' },
    });
    await expect(plan.suggestions(userId, undefined)).rejects.toMatchObject({
      response: { code: 'DIETARY_PROFILE_INCOMPLETE' },
    });
    expect((await plan.preview(userId, [day(dish.id)])).problems).toMatchObject(
      [{ code: 'DIETARY_PROFILE_INCOMPLETE' }],
    );
    await expect(plan.apply(userId, [day(dish.id)])).rejects.toMatchObject({
      response: { code: 'MEAL_PLAN_INVALID' },
    });
    expect(await prisma.mealPlanEntry.count()).toBe(0);
  });

  it('marks saved meals for review without changing them, and permits removal', async () => {
    const milk = await ingredient('Milk', {
      name: 'Milk',
      allergenLabels: ['MILK'],
    });
    const dish = await recipe('Milk dish', milk.id);
    const profile = await confirm();
    await plan.apply(userId, [day(dish.id)]);
    await dietary.patch(userId, {
      expectedVersion: profile.version,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [{ kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] }],
    });
    const saved = await plan.find(userId);
    expect(saved.status).toBe('NEEDS_REVIEW');
    expect(saved.days[0].sections[1].recipes[0].id).toBe(dish.id);
    expect(saved.problems).toMatchObject([{ code: 'AVOIDED_INGREDIENT' }]);
    const cleared = await plan.apply(userId, [{ ...day(dish.id), lunch: [] }]);
    expect(cleared.status).toBe('VALID');
    expect(await prisma.mealPlanEntry.count()).toBe(0);
  });

  it('does not bypass checks by resaving the same recipe after an allergy change', async () => {
    const dish = await recipe(
      'Soy dish',
      (await ingredient('Soy', { name: 'Soy', allergenLabels: ['SOY'] })).id,
    );
    const profile = await confirm();
    await plan.apply(userId, [day(dish.id)]);
    await dietary.patch(userId, {
      expectedVersion: profile.version,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [{ kind: 'ALLERGEN', target: 'SOY', reasons: ['ALLERGY'] }],
    });
    await expect(plan.apply(userId, [day(dish.id)])).rejects.toMatchObject({
      response: { code: 'MEAL_PLAN_INVALID' },
    });
    expect(await prisma.mealPlanEntry.count()).toBe(1);
  });

  it('invalidates old planner proposals using their captured profile version', async () => {
    const dish = await recipe('Rice dish', (await ingredient('Rice')).id);
    const profile = await confirm();
    await dietary.patch(userId, {
      expectedVersion: profile.version,
      dietMode: 'VEGAN',
    });
    await expect(
      plan.suggestions(userId, undefined, profile.version),
    ).rejects.toMatchObject({ response: { code: 'DIETARY_PROFILE_CHANGED' } });
    await expect(
      plan.preview(userId, [day(dish.id)], undefined, profile.version),
    ).rejects.toMatchObject({ response: { code: 'DIETARY_PROFILE_CHANGED' } });
  });

  it('does not treat moving a restricted recipe to another meal as a pure removal', async () => {
    const soy = await recipe(
      'Soy dish',
      (await ingredient('Soy', { name: 'Soy', allergenLabels: ['SOY'] })).id,
    );
    const rice = await recipe('Rice dish', (await ingredient('Rice')).id);
    const profile = await confirm();
    await plan.apply(userId, [{ ...day(soy.id), dinner: [rice.id] }]);
    await dietary.patch(userId, {
      expectedVersion: profile.version,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [{ kind: 'ALLERGEN', target: 'SOY', reasons: ['ALLERGY'] }],
    });
    await expect(
      plan.apply(userId, [{ ...day(soy.id), breakfast: [soy.id], lunch: [] }]),
    ).rejects.toMatchObject({ response: { code: 'MEAL_PLAN_INVALID' } });
    expect(await prisma.mealPlanEntry.count()).toBe(2);
  });

  it('serializes simultaneous plan saves and profile changes without missing the restriction', async () => {
    const soy = await recipe(
      'Soy dish',
      (await ingredient('Soy', { name: 'Soy', allergenLabels: ['SOY'] })).id,
    );
    const profile = await confirm();
    const [saved, changed] = await Promise.allSettled([
      plan.apply(userId, [day(soy.id)]),
      dietary.patch(userId, {
        expectedVersion: profile.version,
        allergyAcknowledgement: 'DECLARED',
        exclusions: [{ kind: 'ALLERGEN', target: 'SOY', reasons: ['ALLERGY'] }],
      }),
    ]);
    expect(changed.status).toBe('fulfilled');
    if (saved.status === 'rejected') {
      expect(saved.reason).toBeInstanceOf(ConflictException);
      const response = (saved.reason as ConflictException).getResponse() as {
        code: string;
      };
      expect(response.code).toMatch(/^MEAL_PLAN_(INVALID|CHANGED)$/);
      expect(await prisma.mealPlanEntry.count()).toBe(0);
    } else {
      expect(await prisma.mealPlanEntry.count()).toBe(1);
      expect((await plan.find(userId)).status).toBe('NEEDS_REVIEW');
    }
  });

  it('hides recipes whose ingredient becomes forbidden and reevaluates saved meals', async () => {
    const food = await ingredient('Composite');
    const dish = await recipe('Composite dish', food.id);
    await confirm();
    await plan.apply(userId, [day(dish.id)]);
    await ingredients.update(food.id, {
      name: food.name,
      expectedSafetyVersion: food.safetyVersion,
      vegetarianStatus: 'FORBIDDEN',
      veganStatus: 'NON_VEGAN',
      animalLabels: ['SLAUGHTER_DERIVED'],
      classificationSource: 'Supplier composition sheet',
      classificationReason: 'Contains slaughter-derived gelatin',
    });
    expect((await catalog.list(query())).meta.totalItems).toBe(0);
    await expect(catalog.findOne(dish.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await plan.find(userId)).status).toBe('NEEDS_REVIEW');
    expect(await prisma.mealPlanEntry.count()).toBe(1);
  });

  it('requires classification sources and protects concurrent safety metadata edits', async () => {
    const food = await ingredient('Rice');
    await expect(
      ingredients.update(food.id, {
        name: food.name,
        expectedSafetyVersion: 1,
        active: false,
      }),
    ).rejects.toMatchObject({
      response: { code: 'CLASSIFICATION_SOURCE_REQUIRED' },
    });
    const input = {
      name: food.name,
      expectedSafetyVersion: 1,
      active: false,
      classificationSource: 'Admin catalog review',
      classificationReason: 'Retired ingredient',
    };
    const results = await Promise.allSettled([
      ingredients.update(food.id, input),
      ingredients.update(food.id, input),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        results.find(
          (row) => row.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(
      (await prisma.ingredient.findUniqueOrThrow({ where: { id: food.id } }))
        .safetyVersion,
    ).toBe(2);
  });

  it('rejects contradictory Vegetarian/Vegan safety claims', async () => {
    await expect(
      ingredients.create({
        name: 'Meat marked Vegetarian',
        vegetarianStatus: 'ALLOWED',
        animalLabels: ['MEAT'],
        classificationSource: 'Review',
        classificationReason: 'Test',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CLASSIFICATION' } });
    await expect(
      ingredients.create({
        name: 'Milk marked Vegan',
        vegetarianStatus: 'ALLOWED',
        veganStatus: 'VEGAN',
        animalLabels: ['DAIRY'],
        classificationSource: 'Review',
        classificationReason: 'Test',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CLASSIFICATION' } });
    await expect(
      ingredients.create({
        name: 'Missing composition',
        compositionComplete: false,
        allergensComplete: true,
        classificationSource: 'Review',
        classificationReason: 'Test',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CLASSIFICATION' } });
    expect(await prisma.ingredient.count()).toBe(0);
  });

  it('applies Vegan exclusions to newly added ingredients without resaving the profile', async () => {
    const profile = await dietary.patch(userId, {
      expectedVersion: 0,
      dietMode: 'VEGAN',
      allergyAcknowledgement: 'NONE_DECLARED',
    });
    const milk = await ingredient('New dairy', {
      name: 'New dairy',
      animalLabels: ['DAIRY'],
      veganStatus: 'NON_VEGAN',
    });
    const dish = await recipe('New dairy dish', milk.id);
    expect(
      (await catalog.list(query({ suitableForMe: true }), userId)).meta
        .totalItems,
    ).toBe(0);
    expect((await plan.preview(userId, [day(dish.id)])).problems).toMatchObject(
      [{ code: 'AVOIDED_INGREDIENT' }],
    );
    expect((await dietary.find(userId)).version).toBe(profile.version);
  });

  it('never deletes an ingredient or group that still protects a dietary profile', async () => {
    const food = await ingredient('Protected rice');
    const group = await prisma.ingredientGroup.create({
      data: {
        name: 'Protected group',
        members: { create: { ingredientId: food.id } },
      },
    });
    await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [
        { kind: 'INGREDIENT', target: food.id, reasons: ['ALLERGY'] },
        { kind: 'GROUP', target: group.id, reasons: ['PERSONAL'] },
      ],
    });
    await expect(ingredients.remove(food.id)).rejects.toMatchObject({
      response: { code: 'INGREDIENT_IN_USE' },
    });
    await expect(ingredients.removeGroup(group.id)).rejects.toMatchObject({
      response: { code: 'GROUP_IN_USE' },
    });
    expect((await dietary.find(userId)).exclusions).toHaveLength(2);
  });

  it('returns suggestions even when many alphabetically earlier recipes are ineligible', async () => {
    const unsafe = await ingredient('Unknown labels', {
      name: 'Unknown labels',
      allergensComplete: false,
    });
    const safe = await ingredient('Safe rice');
    for (let index = 0; index < 65; index++)
      await recipe('A incomplete ' + index, unsafe.id);
    const chosen = await recipe('Z eligible', safe.id);
    await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [
        { kind: 'ALLERGEN', target: 'PEANUT', reasons: ['ALLERGY'] },
      ],
    });
    expect(
      (await plan.suggestions(userId, undefined)).map((row) => row.id),
    ).toEqual([chosen.id]);
  });

  it('keeps exclusions isolated between users and does not publish them in recipe DTOs', async () => {
    const other = await prisma.user.create({
      data: {
        username: 'other.user',
        fullName: 'Other',
        email: 'other@example.test',
        ...confirmedDietaryProfile,
      },
    });
    const dish = await recipe('Rice dish', (await ingredient('Rice')).id);
    await dietary.patch(userId, {
      expectedVersion: 0,
      allergyAcknowledgement: 'DECLARED',
      exclusions: [{ kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] }],
    });
    expect((await dietary.find(other.id)).exclusions).toEqual([]);
    const dto = await catalog.findOne(dish.id);
    expect(dto).not.toHaveProperty('exclusions');
    expect(dto).not.toHaveProperty('dietMode');
    expect(dto.ingredients[0]).toMatchObject({
      allergensComplete: true,
      mayContainAllergens: [],
    });
  });

  it('can round-trip 300 manual exclusions plus automatic Vegan labels', async () => {
    const ids = Array.from({ length: 300 }, () => randomUUID());
    await prisma.ingredient.createMany({
      data: ids.map((id, index) => ({
        id,
        name: 'Excluded ' + index,
        aliases: [],
      })),
    });
    const first = await dietary.patch(userId, {
      expectedVersion: 0,
      dietMode: 'VEGAN',
      exclusions: ids.map((target) => ({
        kind: 'INGREDIENT',
        target,
        reasons: ['PERSONAL'],
      })),
    });
    expect(first.exclusions).toHaveLength(307);
    const next = await dietary.patch(userId, {
      expectedVersion: first.version,
      exclusions: first.exclusions,
    });
    expect(next.exclusions).toEqual(first.exclusions);
    expect(next.version).toBe(2);
  });
});
