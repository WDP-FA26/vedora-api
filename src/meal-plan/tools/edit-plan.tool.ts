import { tool } from 'ai';
import { z } from 'zod';
import { MealSection, Weekday } from '../../mongo/models.js';
import { MAX_DISHES_PER_SECTION } from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';
import { changeFeedback, type PlanChange } from './proposal-text.js';

const slot = {
  day: z.enum(Weekday),
  section: z.enum(MealSection),
};
const slotKey = z.object(slot);
const recipeId = z.uuid().describe('A recipe id from searchRecipes or getPlan');

const operation = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('set'),
      ...slot,
      recipeIds: z
        .array(recipeId)
        .max(MAX_DISHES_PER_SECTION)
        .describe('The full new list of dishes of the slot, in order'),
    })
    .describe('Replace everything in one slot'),
  z
    .object({ op: z.literal('add'), ...slot, recipeId })
    .describe('Add one dish to a slot'),
  z
    .object({ op: z.literal('remove'), ...slot, recipeId })
    .describe('Take one dish out of a slot'),
  z.object({ op: z.literal('clear'), ...slot }).describe('Empty a slot'),
  z
    .object({
      op: z.literal('move'),
      from: slotKey,
      to: slotKey,
      recipeId,
    })
    .describe('Move one dish from a slot to another'),
]);

export type EditPlanOutput = PlanChange & { errors: string[] };

export function editPlanTool(
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Edit individual slots of the user's saved plan right away: set, add, remove, clear or move dishes (up to 60 operations in one call). The change is saved at once and shown in the chat, where the user can rewind it. If a change uses an unknown or avoided recipe, nothing is saved. A same-day ingredient clash is saved with a warning so you can fix whichever dish you choose. A slot on a day before today is refused with DAY_PASSED. Pass weekStart to edit a week other than the one the user has open.",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
      operations: z.array(operation).min(1).max(60),
    }),
    execute: (input): Promise<EditPlanOutput> =>
      mealPlan.editPlan(
        userId,
        input.weekStart ?? openWeekStart,
        input.operations,
      ),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: changeFeedback(output, output.errors),
    }),
  });
}
