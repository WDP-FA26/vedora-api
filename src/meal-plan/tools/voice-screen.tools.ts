import { tool } from 'ai';
import { z } from 'zod';
import type { BmiCategory } from '../../mongo/models.js';
import type { DietaryService } from '../../recipes/dietary.service.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { BMI_LABELS } from '../meal-planner.prompt.js';

/**
 * Voice-mode tools that put something on the user's screen. The API only
 * checks what to show; the browser reads the tool output from the voice turn
 * and opens the matching panel while the voice agent talks.
 */

export function showRecipeTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "Show one recipe card (photo, ingredients, steps) on the user's screen. Call it whenever you talk about a specific dish, so the user can follow along. Pass an id from searchRecipes, getPlan or getRecipe.",
    inputSchema: z.object({
      recipeId: z
        .string()
        .min(1)
        .describe('A recipe id from searchRecipes or getPlan'),
    }),
    execute: async ({ recipeId }) => {
      const recipe = await mealPlan.recipeInstructions(userId, recipeId);
      if (recipe === null) {
        return { shown: false, recipeId, title: null };
      }
      return { shown: true, recipeId, title: recipe.title };
    },
    toModelOutput: ({ output }) => {
      if (!output.shown) {
        return { type: 'text', value: 'Recipe not found; nothing was shown.' };
      }
      return {
        type: 'text',
        value: `Đã mở công thức "${output.title}" trên màn hình.`,
      };
    },
  });
}

export function openEatingLogTool() {
  return tool({
    description:
      "Open the food diary (what the user ate this week) on the user's screen. Call it when the user asks about their diary, after logMeal, or when you review what they ate.",
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('The day to focus, YYYY-MM-DD; leave it out for today'),
    }),
    execute: ({ date }) => ({ opened: true, date: date ?? null }),
    toModelOutput: () => ({
      type: 'text',
      value: 'Đã mở nhật ký ăn uống trên màn hình.',
    }),
  });
}

export function showBodyMetricsTool(dietary: DietaryService, userId: string) {
  return tool({
    description:
      "Show the user's body metrics panel (BMI, weight, target weight, daily kcal target) on screen and read the current values. Call it when the user asks about BMI, weight or their calorie target.",
    inputSchema: z.object({}),
    execute: async () => {
      const profile = await dietary.findNutrition(userId);
      return {
        shown: true,
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        targetWeightKg: profile.targetWeightKg,
        bmi: profile.bmi,
        bmiCategory: profile.bmiCategory,
        dailyCalorieTarget: profile.dailyCalorieTarget,
      };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: `Đã hiện bảng chỉ số cơ thể. ${bodyMetricsText(output)}`,
    }),
  });
}

export interface BodyMetricsSummary {
  heightCm: number | null;
  weightKg: number | null;
  targetWeightKg: number | null;
  bmi: number | null;
  bmiCategory: BmiCategory | null;
  dailyCalorieTarget: number | null;
}

export function bodyMetricsText(metrics: BodyMetricsSummary): string {
  const parts: string[] = [];
  if (metrics.heightCm !== null) parts.push(`cao ${metrics.heightCm} cm`);
  if (metrics.weightKg !== null) parts.push(`nặng ${metrics.weightKg} kg`);
  if (metrics.bmi !== null) {
    parts.push(
      `BMI ${metrics.bmi} (${metrics.bmiCategory === null ? 'chưa phân loại' : BMI_LABELS[metrics.bmiCategory]})`,
    );
  }
  if (metrics.targetWeightKg !== null) {
    parts.push(`mục tiêu ${metrics.targetWeightKg} kg`);
  }
  if (metrics.dailyCalorieTarget !== null) {
    parts.push(`định mức ~${metrics.dailyCalorieTarget} kcal/ngày`);
  }
  if (parts.length === 0) return 'Người dùng chưa nhập chiều cao và cân nặng.';
  return `Hiện tại: ${parts.join(', ')}.`;
}
