import { tool } from 'ai';
import { z } from 'zod';
import { MealSection } from '../../mongo/models.js';
import {
  MEAL_LOG_MAX_CALORIES_PER_SERVING,
  MEAL_LOG_MAX_NAME_LENGTH,
  MEAL_LOG_MAX_SERVINGS,
  MEAL_LOG_MIN_SERVINGS,
  type MealLogEntryDto,
  type UpdateMealLogEntryDto,
} from '../dto/meal-log.dto.js';
import type { MealLogService } from '../meal-log/meal-log.service.js';
import { SECTION_NAMES } from '../meal-planner.prompt.js';

export type EditMealLogOutput =
  | {
      action: 'delete';
      entryId: string;
      done?: boolean;
    }
  | {
      action: 'update';
      entry: MealLogEntryDto;
      done?: boolean;
    };

/**
 * Updates or deletes an existing entry in the user's food diary. Uses the same
 * editable-window rules as `PATCH/DELETE /meal-plan/log/:id`.
 */
export function editMealLogTool(mealLog: MealLogService, userId: string) {
  return tool({
    description: [
      "Update or delete an existing dish in the user's food diary (nhật ký ăn uống).",
      '- action "delete": remove the logged entry permanently (e.g. when the user logged the wrong dish or wants to untick an eaten dish).',
      '- action "update": change servings, caloriesPerServing (pass null to clear), section, or custom dish name on an existing entry.',
      'Pass entryId from getEatingLog or a previous logMeal output. If you do not have the entryId yet, call getEatingLog first. Do not use this to edit the meal plan calendar (use editPlan) or to add a new dish (use logMeal).',
    ].join('\n'),
    inputSchema: z.object({
      action: z.enum(['update', 'delete']),
      entryId: z
        .uuid()
        .describe('The exact entry id from getEatingLog or logMeal'),
      section: z
        .enum(MealSection)
        .optional()
        .describe('Only with action update: move entry to another meal section'),
      servings: z
        .number()
        .min(MEAL_LOG_MIN_SERVINGS)
        .max(MEAL_LOG_MAX_SERVINGS)
        .optional()
        .describe('Only with action update: new servings eaten'),
      name: z
        .string()
        .min(1)
        .max(MEAL_LOG_MAX_NAME_LENGTH)
        .optional()
        .describe('Only with action update on custom dishes: new dish name'),
      caloriesPerServing: z
        .number()
        .int()
        .min(0)
        .max(MEAL_LOG_MAX_CALORIES_PER_SERVING)
        .nullable()
        .optional()
        .describe('Only with action update: new kcal per serving, or null to clear'),
      done: z
        .boolean()
        .optional()
        .describe(
          'Set to true when the user only asked to delete or edit this diary entry and needs no further advice',
        ),
    }),
    execute: async (input): Promise<EditMealLogOutput> => {
      const doneFlag = input.done === true ? { done: true } : {};
      if (input.action === 'delete') {
        await mealLog.remove(userId, input.entryId);
        return { action: 'delete', entryId: input.entryId, ...doneFlag };
      }
      const dto: UpdateMealLogEntryDto = {
        ...(input.section !== undefined ? { section: input.section } : {}),
        ...(input.servings !== undefined ? { servings: input.servings } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.caloriesPerServing !== undefined
          ? { caloriesPerServing: input.caloriesPerServing }
          : {}),
      };
      const entry = await mealLog.update(userId, input.entryId, dto);
      return { action: 'update', entry, ...doneFlag };
    },
    toModelOutput: ({ output }) => {
      if (output.action === 'delete') {
        return {
          type: 'text',
          value: `Đã xóa mục nhật ký [id: ${output.entryId}].`,
        };
      }
      const { entry } = output;
      const kcal =
        entry.calories === null ? 'chưa rõ kcal' : `~${entry.calories} kcal`;
      return {
        type: 'text',
        value: `Đã cập nhật nhật ký ${entry.date}, bữa ${SECTION_NAMES[entry.section]}: ${entry.name} ×${entry.servings} (${kcal}) [id: ${entry.id}].`,
      };
    },
  });
}
