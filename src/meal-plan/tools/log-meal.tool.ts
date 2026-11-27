import { tool } from 'ai';
import { z } from 'zod';
import { MealSection } from '../../mongo/models.js';
import {
  type CreateMealLogEntryDto,
  MEAL_LOG_MAX_CALORIES_PER_SERVING,
  MEAL_LOG_MAX_NAME_LENGTH,
  MEAL_LOG_MAX_SERVINGS,
  MEAL_LOG_MIN_SERVINGS,
} from '../dto/meal-log.dto.js';
import type { MealLogService } from '../meal-log/meal-log.service.js';
import { SECTION_NAMES } from '../meal-planner.prompt.js';

export function logMealTool(mealLog: MealLogService, userId: string) {
  return tool({
    description:
      'Log a dish the user says they ate into their food diary. Use a recipeId when the dish is a Vedora recipe (from getPlan or searchRecipes); otherwise pass its name and, if the user said it, kcal per serving. Log only what the user clearly said they ate; ask first when the meal or day is unclear.',
    inputSchema: z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            'The day eaten, YYYY-MM-DD; today unless the user said otherwise',
          ),
        section: z.enum(MealSection),
        recipeId: z.uuid().optional().describe('A Vedora recipe id'),
        name: z
          .string()
          .min(1)
          .max(MEAL_LOG_MAX_NAME_LENGTH)
          .optional()
          .describe('A dish outside the catalog, in Vietnamese'),
        servings: z
          .number()
          .min(MEAL_LOG_MIN_SERVINGS)
          .max(MEAL_LOG_MAX_SERVINGS)
          .optional()
          .describe('Servings eaten, default 1'),
        caloriesPerServing: z
          .number()
          .int()
          .min(0)
          .max(MEAL_LOG_MAX_CALORIES_PER_SERVING)
          .optional()
          .describe('kcal per serving, only when the user said it'),
        done: z
          .boolean()
          .optional()
          .describe(
            'Set to true when the user only asked to log this meal and needs no further advice',
          ),
      })
      .refine(
        (input) =>
          (input.recipeId === undefined) !== (input.name === undefined),
        { message: 'Send exactly one of recipeId and name' },
      ),
    execute: async (input) => {
      const dto: CreateMealLogEntryDto = {
        date: input.date,
        section: input.section,
        servings: input.servings,
        recipeId: input.recipeId,
        name: input.name,
        caloriesPerServing: input.caloriesPerServing,
      };
      const entry = await mealLog.create(userId, dto);
      return input.done === true ? { entry, done: true } : { entry };
    },
    toModelOutput: ({ output }) => {
      const { entry } = output;
      const kcal =
        entry.calories === null ? 'chưa rõ kcal' : `~${entry.calories} kcal`;
      return {
        type: 'text',
        value: `Đã ghi vào nhật ký ${entry.date}, bữa ${SECTION_NAMES[entry.section]}: ${entry.name} ×${entry.servings} (${kcal}) [id: ${entry.id}].`,
      };
    },
  });
}
