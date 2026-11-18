import { tool } from 'ai';
import { z } from 'zod';
import { MealSection, Weekday } from '../../mongo/models.js';
import { MAX_DISHES_PER_SECTION } from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { proposalFeedback, type DraftProposal } from './proposal-text.js';

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

export type EditDraftOutput = DraftProposal & { errors: string[] };

export function editDraftTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      'Directly edit individual slots of the unsaved draft: set, add, remove, clear or move dishes (up to 60 operations in one call). If a change uses an unknown or avoided recipe, nothing is kept. If it causes a same-day ingredient clash, the draft stays saved so you can see the full day and fix whichever dish you choose. Nothing is saved to the permanent timetable until the user presses "Áp dụng".',
    inputSchema: z.object({
      operations: z.array(operation).min(1).max(60),
    }),
    execute: (input): Promise<EditDraftOutput> =>
      mealPlan.editDraft(userId, input.operations),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: proposalFeedback(output, output.errors),
    }),
  });
}
