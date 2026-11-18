import { tool } from 'ai';
import { z } from 'zod';
import { RecipeTag } from '../../mongo/models.js';
import type {
  MealPlanService,
  RecipeSuggestion,
} from '../meal-plan.service.js';

export function searchRecipesTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "List Vedora recipes this user can eat (recipes with an ingredient they avoid are already left out). Without a query it returns the catalog; with one it matches titles and ingredient names in Vietnamese, e.g. 'đậu hũ' or 'canh'. If a query finds nothing, call it again without one. Returns each recipe's id, title, total minutes and ingredients.",
    inputSchema: z.object({
      query: z
        .string()
        .max(100)
        .optional()
        .describe('A Vietnamese dish or ingredient name, with accents'),
      tag: z
        .enum(RecipeTag)
        .optional()
        .describe('Only dishes of this type, e.g. SOUP or DRINK'),
      maxMinutes: z
        .number()
        .int()
        .min(1)
        .max(240)
        .optional()
        .describe('Only dishes whose prep plus cook time is at most this'),
    }),
    execute: ({ query, tag, maxMinutes }) =>
      mealPlan.suggestions(userId, query, { tag, maxMinutes }),
    toModelOutput: ({ output }) => ({ type: 'text', value: lines(output) }),
  });
}

function lines(recipes: RecipeSuggestion[]): string {
  if (recipes.length === 0) return 'No recipes found.';
  return recipes
    .map(
      ({ id, title, tag, minutes, ingredients }) =>
        `${id} | ${title} | ${tag ?? 'chưa phân loại'} | ${minutes === null ? '?' : minutes} phút | ${ingredients.join(', ')}`,
    )
    .join('\n');
}
