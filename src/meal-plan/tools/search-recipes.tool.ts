import { tool } from 'ai';
import { z } from 'zod';
import type { MealPlanService, RecipeSuggestion } from '../meal-plan.service';

export function searchRecipesTool(
  mealPlan: MealPlanService,
  userId: string,
  expectedVersion?: number,
) {
  return tool({
    description:
      "List Vedora recipes this user can eat (recipes with an ingredient they avoid are already left out). Without a query it returns the catalog; with one it matches titles and ingredient names in Vietnamese, e.g. 'đậu hũ' or 'canh'. If a query finds nothing, call it again without one. Returns each recipe's id, title, total minutes and ingredients.",
    inputSchema: z.object({
      query: z
        .string()
        .max(100)
        .optional()
        .describe('A Vietnamese dish or ingredient name, with accents'),
    }),
    execute: ({ query }) =>
      mealPlan.suggestions(userId, query, expectedVersion),
    toModelOutput: ({ output }) => ({ type: 'text', value: lines(output) }),
  });
}

function lines(recipes: RecipeSuggestion[]): string {
  if (recipes.length === 0) return 'No recipes found.';
  return recipes
    .map(
      ({ id, title, minutes, ingredients }) =>
        `${id} | ${title} | ${minutes === null ? '?' : minutes} phút | ${ingredients.join(', ')}`,
    )
    .join('\n');
}
