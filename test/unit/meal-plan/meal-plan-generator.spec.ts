import { describe, expect, it } from 'vitest';
import {
  MealSection,
  NutritionGoal,
  NutritionPillar,
  RecipeTag,
  Weekday,
} from '../../../src/mongo/models.js';
import {
  generateMealDays,
  type GeneratorCandidate,
  type SlotRecipeIds,
} from '../../../src/meal-plan/meal-plan-generator.js';

function candidate(
  id: string,
  tag: RecipeTag,
  extra: Partial<GeneratorCandidate> = {},
): GeneratorCandidate {
  return {
    id,
    title: id,
    tag,
    minutes: 30,
    ingredientIds: [],
    matchesQuery: false,
    ...extra,
  };
}

function slots(breakfast: string[], lunch: string[] = []): SlotRecipeIds {
  return { BREAKFAST: breakfast, LUNCH: lunch, DINNER: [], OTHER: [] };
}

const allCompatible = (sets: string[][]) =>
  Promise.resolve(sets.map(() => true));

describe('generateMealDays', () => {
  it('gives every replaced slot a different dish when another one fits', async () => {
    const days = [Weekday.THU, Weekday.FRI, Weekday.SAT, Weekday.SUN];
    const saved = new Map<Weekday, SlotRecipeIds>([
      [Weekday.THU, slots(['soup-1'])],
      [Weekday.FRI, slots(['soup-2'])],
      [Weekday.SAT, slots(['soup-3'])],
      [Weekday.SUN, slots(['soup-4'])],
    ]);
    // Eight breakfast dishes: four free ones are already eaten at Monday's
    // lunch, so the dish being replaced is the least used one in the week.
    const candidates = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      candidate(`soup-${n}`, RecipeTag.SOUP),
    );
    const usedElsewhere = new Map(saved);
    usedElsewhere.set(
      Weekday.MON,
      slots([], ['soup-5', 'soup-6', 'soup-7', 'soup-8']),
    );

    for (let run = 0; run < 50; run += 1) {
      const generated = await generateMealDays({
        candidates,
        saved: usedElsewhere,
        days,
        sections: [MealSection.BREAKFAST],
        skip: [],
        onlyEmpty: false,
        perSection: 1,
        ignoreFit: false,
        areCompatible: allCompatible,
        random: Math.random,
      });

      expect(generated.map(({ day }) => day)).toEqual(days);
      for (const { day, BREAKFAST } of generated) {
        expect(BREAKFAST).not.toEqual(saved.get(day)?.BREAKFAST);
      }
    }
  });

  it('keeps the old dish when it is the only one that fits', async () => {
    const generated = await generateMealDays({
      candidates: [candidate('soup-1', RecipeTag.SOUP)],
      saved: new Map([[Weekday.THU, slots(['soup-1'])]]),
      days: [Weekday.THU],
      sections: [MealSection.BREAKFAST],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      areCompatible: allCompatible,
      random: () => 0,
    });

    // Unchanged days are not returned, so the saved dish stays in place.
    expect(generated).toEqual([]);
  });

  it('prefers lighter dinners for LOSE_WEIGHT and expands GAIN_WEIGHT lunch/dinner with a complementary dish', async () => {
    const lightDinner = candidate('light-soup', RecipeTag.SOUP, {
      caloriesPerServing: 160,
      nutritionPillars: [
        NutritionPillar.PLANT_PROTEIN,
        NutritionPillar.FIBER_VEG,
      ],
    });
    const heavyDinner = candidate('heavy-curry', RecipeTag.STIR_FRY, {
      caloriesPerServing: 480,
      nutritionPillars: [NutritionPillar.HEALTHY_FAT],
    });
    const loseResult = await generateMealDays({
      candidates: [heavyDinner, lightDinner],
      saved: new Map(),
      days: [Weekday.MON],
      sections: [MealSection.DINNER],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      nutritionGoal: NutritionGoal.LOSE_WEIGHT,
      dailyCalorieTarget: 1400,
      areCompatible: allCompatible,
      random: () => 0,
    });
    expect(loseResult[0]?.DINNER).toEqual(['light-soup']);

    const heartyMain = candidate('rice-dish', RecipeTag.RICE, {
      caloriesPerServing: 360,
      nutritionPillars: [NutritionPillar.PLANT_PROTEIN],
    });
    const soupSide = candidate('side-soup', RecipeTag.SOUP, {
      caloriesPerServing: 180,
      nutritionPillars: [NutritionPillar.FIBER_VEG],
    });
    const gainResult = await generateMealDays({
      candidates: [heartyMain, soupSide],
      saved: new Map(),
      days: [Weekday.MON],
      sections: [MealSection.LUNCH],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      nutritionGoal: NutritionGoal.GAIN_WEIGHT,
      dailyCalorieTarget: 2200,
      areCompatible: allCompatible,
      random: () => 0,
    });
    expect(gainResult[0]?.LUNCH).toEqual(['rice-dish', 'side-soup']);
  });

  it('expands full days with multiple complementary dishes and snacks when below calorie target, while leaving partial days untouched', async () => {
    const pho = candidate('pho', RecipeTag.NOODLES, {
      caloriesPerServing: 390,
      nutritionPillars: [NutritionPillar.PLANT_PROTEIN],
    });
    const rice = candidate('rice', RecipeTag.RICE, {
      caloriesPerServing: 430,
      nutritionPillars: [NutritionPillar.HEALTHY_FAT],
    });
    const tofu = candidate('tofu', RecipeTag.STIR_FRY, {
      caloriesPerServing: 260,
      nutritionPillars: [
        NutritionPillar.PLANT_PROTEIN,
        NutritionPillar.CALCIUM_RICH,
      ],
    });
    const greens = candidate('greens', RecipeTag.STIR_FRY, {
      caloriesPerServing: 160,
      nutritionPillars: [NutritionPillar.FIBER_VEG],
    });
    const soup = candidate('soup', RecipeTag.SOUP, {
      caloriesPerServing: 140,
      nutritionPillars: [NutritionPillar.IRON_RICH],
    });
    const smoothie = candidate('smoothie', RecipeTag.DRINK, {
      caloriesPerServing: 420,
      nutritionPillars: [NutritionPillar.HEALTHY_FAT],
    });
    const soyMilk = candidate('soy-milk', RecipeTag.DRINK, {
      caloriesPerServing: 210,
      nutritionPillars: [NutritionPillar.PLANT_PROTEIN],
    });
    const salad = candidate('salad', RecipeTag.SALAD, {
      caloriesPerServing: 280,
      nutritionPillars: [NutritionPillar.FIBER_VEG],
    });

    const pool = [pho, rice, tofu, greens, soup, smoothie, soyMilk, salad];
    const generated = await generateMealDays({
      candidates: pool,
      saved: new Map(),
      days: [Weekday.MON],
      sections: [
        MealSection.BREAKFAST,
        MealSection.LUNCH,
        MealSection.DINNER,
        MealSection.OTHER,
      ],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      nutritionGoal: NutritionGoal.MAINTAIN,
      dailyCalorieTarget: 2000,
      areCompatible: allCompatible,
      random: () => 0,
    });

    const monday = generated[0];
    expect(monday).toBeDefined();
    const byId = new Map(pool.map((item) => [item.id, item]));
    const totalIds = [
      ...(monday?.BREAKFAST ?? []),
      ...(monday?.LUNCH ?? []),
      ...(monday?.DINNER ?? []),
      ...(monday?.OTHER ?? []),
    ];
    const totalKcal = totalIds.reduce(
      (sum, id) => sum + (byId.get(id)?.caloriesPerServing ?? 0),
      0,
    );
    expect(totalIds.length).toBeGreaterThan(3);
    expect(totalKcal).toBeGreaterThanOrEqual(Math.round(2000 * 0.88));
    expect(totalKcal).toBeLessThanOrEqual(Math.round(2000 * 1.15));

    // Partial eating-out schedule (only DINNER filled) should remain 1 dish.
    const partialOnly = await generateMealDays({
      candidates: pool,
      saved: new Map(),
      days: [Weekday.TUE],
      sections: [MealSection.DINNER],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      nutritionGoal: NutritionGoal.MAINTAIN,
      dailyCalorieTarget: 2000,
      areCompatible: allCompatible,
      random: () => 0,
    });
    expect(partialOnly[0]?.DINNER).toHaveLength(1);
  });
});
