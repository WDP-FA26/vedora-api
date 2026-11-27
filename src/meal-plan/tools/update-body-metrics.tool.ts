import { tool } from 'ai';
import { z } from 'zod';
import {
  ActivityLevel,
  BiologicalSex,
  NutritionGoal,
} from '../../mongo/models.js';
import type { DietaryService } from '../../recipes/dietary.service.js';
import { bodyMetricsText } from './voice-screen.tools.js';

/**
 * Updates body metrics (height, weight, target weight, birth year, biological
 * sex, activity level, or nutrition goal) and optionally fixes a past day's
 * weight check-in when `date` is provided.
 */
export function updateBodyMetricsTool(dietary: DietaryService, userId: string) {
  return tool({
    description:
      "Update the user's body metrics when they tell you a new value: height, current weight, target weight, birth year, biological sex, activity level, or nutrition goal. Pass `date` (YYYY-MM-DD, today or earlier) together with `weightKg` to fix or log weight for a specific past day without overwriting today. BMI and the daily kcal target are recalculated from them. Change only the fields the user gave; confirm unusual values before saving.",
    inputSchema: z
      .object({
        heightCm: z.number().int().min(100).max(250).optional(),
        weightKg: z.number().min(25).max(300).optional(),
        targetWeightKg: z.number().min(25).max(300).optional(),
        birthYear: z.number().int().min(1900).max(2100).optional(),
        biologicalSex: z.enum(BiologicalSex).optional(),
        activityLevel: z.enum(ActivityLevel).optional(),
        nutritionGoal: z.enum(NutritionGoal).optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'Optional past or current date (YYYY-MM-DD) when fixing or logging weight for a specific day',
          ),
        done: z
          .boolean()
          .optional()
          .describe(
            'Set to true when the user only asked to save these metrics and needs no further advice',
          ),
      })
      .refine(
        (input) =>
          input.heightCm !== undefined ||
          input.weightKg !== undefined ||
          input.targetWeightKg !== undefined ||
          input.birthYear !== undefined ||
          input.biologicalSex !== undefined ||
          input.activityLevel !== undefined ||
          input.nutritionGoal !== undefined,
        {
          message: 'Send at least one field',
        },
      ),
    execute: async (input) => {
      const roundedWeight = roundTenth(input.weightKg);
      const hasProfileFields =
        input.heightCm !== undefined ||
        input.targetWeightKg !== undefined ||
        input.birthYear !== undefined ||
        input.biologicalSex !== undefined ||
        input.activityLevel !== undefined ||
        input.nutritionGoal !== undefined ||
        (roundedWeight !== undefined && input.date === undefined);

      let profile = hasProfileFields
        ? await dietary.saveNutrition(userId, {
            heightCm: input.heightCm,
            weightKg: input.date === undefined ? roundedWeight : undefined,
            targetWeightKg: roundTenth(input.targetWeightKg),
            birthYear: input.birthYear,
            biologicalSex: input.biologicalSex,
            activityLevel: input.activityLevel,
            nutritionGoal: input.nutritionGoal,
          })
        : null;

      if (input.date !== undefined && roundedWeight !== undefined) {
        profile = await dietary.checkInWeight(userId, {
          weightKg: roundedWeight,
          date: input.date,
          ...(input.heightCm !== undefined ? { heightCm: input.heightCm } : {}),
        });
      }

      const resolved = profile ?? (await dietary.findNutrition(userId));
      return {
        heightCm: resolved.heightCm,
        weightKg: resolved.weightKg,
        targetWeightKg: resolved.targetWeightKg,
        bmi: resolved.bmi,
        bmiCategory: resolved.bmiCategory,
        dailyCalorieTarget: resolved.dailyCalorieTarget,
        profile: resolved,
        ...(input.done === true ? { done: true } : {}),
      };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: `Đã lưu chỉ số mới. ${bodyMetricsText(output)}`,
    }),
  });
}

function roundTenth(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 10) / 10;
}
