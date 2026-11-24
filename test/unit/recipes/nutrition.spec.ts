import { describe, expect, it } from 'vitest';
import {
  ActivityLevel,
  BiologicalSex,
  BmiCategory,
  NutritionGoal,
  NutritionPillar,
  RecipeTag,
} from '@src/mongo/models.js';
import {
  calculateBmi,
  classifyAsianBmi,
  computeNutritionMetrics,
  extractAllergyKeywords,
  inferNutritionPillars,
  resolveCaloriesPerServing,
} from '@src/recipes/nutrition.js';

describe('nutrition helpers', () => {
  it('calculates BMI and classifies according to Asian WPRO thresholds', () => {
    expect(calculateBmi(49, 168)).toBe(17.4);
    expect(classifyAsianBmi(17.4)).toBe(BmiCategory.UNDERWEIGHT);
    expect(classifyAsianBmi(18.5)).toBe(BmiCategory.NORMAL);
    expect(classifyAsianBmi(22.9)).toBe(BmiCategory.NORMAL);
    expect(classifyAsianBmi(23.0)).toBe(BmiCategory.OVERWEIGHT);
    expect(classifyAsianBmi(24.9)).toBe(BmiCategory.OVERWEIGHT);
    expect(classifyAsianBmi(25.0)).toBe(BmiCategory.OBESE);
  });

  it('computes TDEE and safe daily targets across BMI goals', () => {
    const overweight = computeNutritionMetrics(
      {
        heightCm: 160,
        weightKg: 63,
        targetWeightKg: 55,
        birthYear: 1998,
        biologicalSex: BiologicalSex.FEMALE,
        activityLevel: ActivityLevel.LIGHT,
        nutritionGoal: null,
      },
      2026,
    );
    expect(overweight.bmi).toBe(24.6);
    expect(overweight.bmiCategory).toBe(BmiCategory.OVERWEIGHT);
    expect(overweight.suggestedGoal).toBe(NutritionGoal.LOSE_WEIGHT);
    expect(overweight.effectiveGoal).toBe(NutritionGoal.LOSE_WEIGHT);
    expect(overweight.idealWeightMinKg).toBe(47.4);
    expect(overweight.idealWeightMaxKg).toBe(58.6);
    expect(overweight.tdee).toBeGreaterThan(1500);
    expect(overweight.dailyCalorieTarget).toBe(
      Math.max(1200, (overweight.tdee ?? 0) - 350),
    );
    expect(overweight.safetyNote).toBeNull();

    const underweightTryingToLose = computeNutritionMetrics(
      {
        heightCm: 168,
        weightKg: 49,
        targetWeightKg: null,
        birthYear: 2004,
        biologicalSex: BiologicalSex.FEMALE,
        activityLevel: ActivityLevel.LIGHT,
        nutritionGoal: NutritionGoal.LOSE_WEIGHT,
      },
      2026,
    );
    expect(underweightTryingToLose.bmiCategory).toBe(BmiCategory.UNDERWEIGHT);
    expect(underweightTryingToLose.dailyCalorieTarget).toBe(
      underweightTryingToLose.tdee,
    );
    expect(underweightTryingToLose.safetyNote).toContain('18,5');
  });

  it('infers plant-based nutrition pillars without mistaking annatto seeds for cashews', () => {
    const pillars = inferNutritionPillars([
      'Đậu hũ',
      'Rau bina',
      'Mè đen',
      'Hạt điều màu',
    ]);
    expect(pillars).toContain(NutritionPillar.PLANT_PROTEIN);
    expect(pillars).toContain(NutritionPillar.FIBER_VEG);
    expect(pillars).toContain(NutritionPillar.IRON_RICH);
    expect(pillars).toContain(NutritionPillar.CALCIUM_RICH);
    expect(pillars).toContain(NutritionPillar.HEALTHY_FAT);

    const annattoOnly = inferNutritionPillars(['Bún tươi', 'Hạt điều màu']);
    expect(annattoOnly).not.toContain(NutritionPillar.HEALTHY_FAT);
    expect(annattoOnly).not.toContain(NutritionPillar.PLANT_PROTEIN);
  });

  it('resolves stored calories or estimates realistic per-serving fallback', () => {
    expect(
      resolveCaloriesPerServing({
        caloriesPerServing: 315,
        tag: RecipeTag.SOUP,
        title: 'Canh chay',
        ingredientNames: ['Cà rốt'],
      }),
    ).toBe(315);

    const soup = resolveCaloriesPerServing({
      caloriesPerServing: null,
      tag: RecipeTag.SOUP,
      title: 'Canh bí đao',
      ingredientNames: ['Bí đao'],
    });
    const friedRice = resolveCaloriesPerServing({
      caloriesPerServing: null,
      tag: RecipeTag.RICE,
      title: 'Cơm chiên đậu hũ',
      ingredientNames: ['Gạo tẻ', 'Đậu hũ'],
    });
    expect(soup).toBeLessThan(friedRice);
  });

  it('extracts allergen keywords and Vietnamese derivative families from natural-language notes', () => {
    const soyKeywords = extractAllergyKeywords('Mình bị dị ứng đậu nành và mè');
    expect(soyKeywords).toContain('đậu hũ');
    expect(soyKeywords).toContain('nước tương');
    expect(soyKeywords).toContain('hạt mè');

    const peanutKeywords = extractAllergyKeywords(
      'Không ăn được đậu phộng, kiêng ăn cay',
    );
    expect(peanutKeywords).toContain('đậu phộng');
    expect(peanutKeywords).toContain('ớt');

    expect(extractAllergyKeywords('   ')).toEqual([]);
    expect(extractAllergyKeywords(null)).toEqual([]);
  });
});
