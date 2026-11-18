import { tool } from 'ai';
import { z } from 'zod';
import { MealSection, RecipeTag, Weekday } from '../../mongo/models.js';
import {
  MAX_DISHES_PER_SECTION,
  MAX_GENERATE_EXCLUDES,
  MAX_GENERATE_IDS,
  MAX_GENERATE_MINUTES,
  MAX_GENERATE_QUERY_LENGTH,
} from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { proposalFeedback, type DraftProposal } from './proposal-text.js';

const slotKey = z.object({
  day: z.enum(Weekday),
  section: z.enum(MealSection),
  recipeIds: z
    .array(z.uuid())
    .max(MAX_DISHES_PER_SECTION)
    .optional()
    .describe(
      'Optional recipe ids to place in this pinned slot while filling the rest of the schedule',
    ),
});

const input = z.object({
  days: z
    .array(z.enum(Weekday))
    .min(1)
    .max(7)
    .describe('Days to fill, e.g. all seven for a whole week'),
  sections: z
    .array(z.enum(MealSection))
    .min(1)
    .max(4)
    .describe(
      'Sections to fill. Usually BREAKFAST, LUNCH and DINNER; OTHER only for snacks, drinks or desserts the user asked for',
    ),
  onlyEmpty: z
    .boolean()
    .describe(
      'true keeps every slot that already has a dish (saved or in the draft); false replaces the chosen slots',
    ),
  candidateIds: z
    .array(z.uuid())
    .max(MAX_GENERATE_IDS)
    .optional()
    .describe(
      'Choose only from these recipes. The most flexible control: search for dishes that fit the request, judge them yourself, then pass the ids you accept',
    ),
  avoidIds: z
    .array(z.uuid())
    .max(MAX_GENERATE_IDS)
    .optional()
    .describe('Never choose these recipes'),
  pinned: z
    .array(slotKey)
    .max(28)
    .optional()
    .describe(
      'Slots to keep as they are, or set to specific recipeIds before filling the rest',
    ),
  maxMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_GENERATE_MINUTES)
    .optional()
    .describe('Longest total cooking time of a dish, in minutes'),
  query: z
    .string()
    .max(MAX_GENERATE_QUERY_LENGTH)
    .optional()
    .describe(
      'One dish or ingredient to prefer, in Vietnamese with accents. A preference only',
    ),
  exclude: z
    .array(z.string().min(1).max(MAX_GENERATE_QUERY_LENGTH))
    .max(MAX_GENERATE_EXCLUDES)
    .optional()
    .describe(
      'Words a dish must not have in its title or ingredients, e.g. ["chiên"]. Weaker than avoidIds because it only sees the title and ingredients',
    ),
  tags: z
    .array(z.enum(RecipeTag))
    .max(9)
    .optional()
    .describe(
      'Only dishes of these types (SOUP, SALAD, RICE, NOODLES, STIR_FRY, BREAD, DESSERT, DRINK, SNACK); untagged dishes are then left out',
    ),
  perSection: z
    .number()
    .int()
    .min(1)
    .max(MAX_DISHES_PER_SECTION)
    .optional()
    .describe('Dishes per filled slot, default 1'),
});

export type FillSlotsOutput = DraftProposal & {
  filled: number;
  allSlotsAlreadyFilled: boolean;
};

export function fillSlotsTool(
  mealPlan: MealPlanService,
  userId: string,
  weekStart: string,
) {
  return tool({
    description:
      'Optional helper to fill many slots at once with an algorithm that respects avoided ingredients, cooking time, same-day clashes and meal variety (a dish never repeats within one meal across the week; days before today are skipped). Combine freely with editDraft in any order: pass onlyEmpty: true to fill empty slots around dishes you placed, or onlyEmpty: false (with optional pinned slots/recipeIds) to build or refresh a range.',
    inputSchema: input,
    execute: (request): Promise<FillSlotsOutput> =>
      mealPlan.fillDraft(userId, { ...request, weekStart }),
    toModelOutput: ({ output }) => {
      if (output.filled === 0 && output.problems.length === 0) {
        return {
          type: 'text',
          value: output.allSlotsAlreadyFilled
            ? 'Every requested slot already has a dish. To replace existing dishes, call fillSlots again with onlyEmpty: false (and use pinned for any slot you want to keep).'
            : 'No dish fits these requests, so nothing changed. Relax the filters or omit candidateIds.',
        };
      }
      return { type: 'text', value: proposalFeedback(output) };
    },
  });
}
