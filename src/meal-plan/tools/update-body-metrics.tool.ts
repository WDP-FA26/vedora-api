import { tool } from 'ai';
import { z } from 'zod';
import { ActivityLevel, NutritionGoal } from '../../mongo/models.js';
import type { DietaryService } from '../../recipes/dietary.service.js';
import { bodyMetricsText } from './voice-screen.tools.js';

/**
 * Updates height, weight, target weight, activity or goal, the inputs of the
 * BMI and the daily kcal target, with the same checks as
 * `PUT /dietary/nutrition`. A new weight is also recorded in the history.
 */
export function updateBodyMetricsTool(dietary: DietaryService, userId: string) {
  return tool({
    description:
      "Update the user's body metrics when they tell you a new value: height, current weight, target weight, activity level or goal. BMI and the daily kcal target are recalculated from them. Change only the fields the user gave; confirm unusual values before saving.",
    inputSchema: z
      .object({
        heightCm: z.number().int().min(100).max(250).optional(),
        weightKg: z.number().min(25).max(300).optional(),
        targetWeightKg: z.number().min(25).max(300).optional(),
        activityLevel: z.enum(ActivityLevel).optional(),
        nutritionGoal: z.enum(NutritionGoal).optional(),
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
          input.activityLevel !== undefined ||
          input.nutritionGoal !== undefined,
        {
          message: 'Send at least one field',
        },
      ),
    execute: async (input) => {
      const profile = await dietary.saveNutrition(userId, {
        heightCm: input.heightCm,
        weightKg: roundTenth(input.weightKg),
        targetWeightKg: roundTenth(input.targetWeightKg),
        activityLevel: input.activityLevel,
        nutritionGoal: input.nutritionGoal,
      });
      return {
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        targetWeightKg: profile.targetWeightKg,
        bmi: profile.bmi,
        bmiCategory: profile.bmiCategory,
        dailyCalorieTarget: profile.dailyCalorieTarget,
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
