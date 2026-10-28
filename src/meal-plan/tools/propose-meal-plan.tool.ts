import { Weekday } from '../../mongo/models.js';
import { tool } from 'ai';
import { z } from 'zod';
import {
  MAX_DISHES_PER_SECTION,
  type MealPlanProblemDto,
} from '../dto/meal-plan.dto.js';
import type { MealPlanPreview, MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES } from '../meal-planner.prompt.js';

export type MealPlanProposal = MealPlanPreview & { ok: boolean };

const dishIds = (what: string) =>
  z.array(z.uuid()).max(MAX_DISHES_PER_SECTION).describe(what);

const input = z.object({
  days: z
    .array(
      z.object({
        day: z.enum(Weekday),
        breakfast: dishIds('Recipe ids for breakfast, usually one'),
        lunch: dishIds('Recipe ids for lunch, usually one'),
        dinner: dishIds('Recipe ids for dinner, usually one'),
        others: dishIds(
          'Recipe ids for anything outside the three meals (snacks, drinks, desserts, extra dishes); empty unless the user asks',
        ),
      }),
    )
    .min(1)
    .max(7)
    .describe(
      'Only the days that change; the others stay as saved. Each day here replaces that whole day, so repeat the dishes that stay. An empty list clears that section.',
    ),
});

/** Checks new day lists and shows them to the user, who saves them. Writes nothing. */
export function proposeMealPlanTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      'Show the user a change to their weekly timetable. Nothing is saved: the user presses "Áp dụng" on the card to save it. The changes are checked first; when the result lists problems the card is not shown, so fix them with other recipes and call again.',
    inputSchema: input,
    execute: async ({ days }): Promise<MealPlanProposal> => {
      const preview = await mealPlan.preview(userId, days);
      return { ...preview, ok: preview.problems.length === 0 };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.ok
        ? 'The proposal is on screen, not saved. Ask the user to press "Áp dụng" or say what to change.'
        : `Not shown. Fix these and call again:\n${output.problems.map(describe).join('\n')}`,
    }),
  });
}

function describe(problem: MealPlanProblemDto): string {
  const day = DAY_NAMES[problem.day];
  const recipes = problem.recipes.join(', ');
  switch (problem.code) {
    case 'UNKNOWN_RECIPE':
      return `- ${day}: a recipeId does not exist; use ids from searchRecipes.`;
    case 'AVOIDED_INGREDIENT':
      return `- ${day}: "${recipes}" has ${problem.ingredients.join(', ')}, which the user does not eat.`;
    case 'DAY_CONFLICT':
      return `- ${day}: ${problem.ingredients.join(' and ')} must not be eaten on the same day (${problem.reason ?? 'incompatible'}); they come from: ${recipes}.`;
  }
}
