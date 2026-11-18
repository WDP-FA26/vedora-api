import { tool } from 'ai';
import { z } from 'zod';
import { MealSection, RecipeTag, Weekday } from '../../mongo/models.js';
import {
  MAX_DISHES_PER_SECTION,
  MAX_GENERATE_EXCLUDES,
  MAX_GENERATE_MINUTES,
  MAX_GENERATE_QUERY_LENGTH,
} from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import type { MealPlanProposal } from './propose-meal-plan.tool.js';

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
      'Sections to fill with one dish each. Usually BREAKFAST, LUNCH and DINNER; OTHER only when the user asks for snacks, drinks or desserts',
    ),
  onlyEmpty: z
    .boolean()
    .describe(
      'true keeps every slot that already has a dish; false replaces the chosen sections',
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
      'One dish or ingredient to prefer, in Vietnamese with accents. Only a preference: not every slot will have it',
    ),
  exclude: z
    .array(z.string().min(1).max(MAX_GENERATE_QUERY_LENGTH))
    .max(MAX_GENERATE_EXCLUDES)
    .optional()
    .describe(
      'Words a dish must never have in its title or ingredients, in Vietnamese with accents, e.g. ["chiên"]. A hard filter',
    ),
  tags: z
    .array(z.enum(RecipeTag))
    .max(9)
    .optional()
    .describe(
      'Only pick dishes of these types (SOUP, SALAD, RICE, NOODLES, STIR_FRY, BREAD, DESSERT, DRINK, SNACK). Untagged dishes are then left out',
    ),
  perSection: z
    .number()
    .int()
    .min(1)
    .max(MAX_DISHES_PER_SECTION)
    .optional()
    .describe('Dishes per filled slot, default 1'),
});

export function generateMealPlanTool(
  mealPlan: MealPlanService,
  userId: string,
) {
  return tool({
    description:
      'Fill many meal slots at once with an algorithm: fast, and it already respects avoided ingredients, cooking time, variety and same-day clashes. Prefer it over picking dishes one by one when the user wants a whole week, several days or all empty meals. It shows the result to the user as a proposal; nothing is saved. To swap one dish, call it with that one day and section, onlyEmpty false. Afterwards you may fine-tune slots with proposeMealPlan.',
    inputSchema: input,
    execute: async (request): Promise<MealPlanProposal> => {
      const preview = await mealPlan.generate(userId, request);
      return {
        ...preview,
        ok: preview.days.length > 0 && preview.problems.length === 0,
      };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: summarize(output),
    }),
  });
}

function summarize(proposal: MealPlanProposal): string {
  if (proposal.days.length === 0) {
    return 'No dish fits these requests. Relax the time limit or the sections, or ask the user.';
  }
  if (!proposal.ok) {
    return 'The generated dishes did not pass the checks. Try again.';
  }
  const days = proposal.days.map(({ day, sections }) => {
    const filled = sections
      .filter(({ recipes }) => recipes.length > 0)
      .map(
        ({ section, recipes }) =>
          `${SECTION_NAMES[section]}: ${recipes.map(({ title, id }) => `${title} (id ${id})`).join(', ')}`,
      );
    return `- ${DAY_NAMES[day]}: ${filled.join('; ')}`;
  });
  return `The proposal is on screen, not saved. Ask the user to press "Áp dụng" or say what to change.\n${days.join('\n')}`;
}
