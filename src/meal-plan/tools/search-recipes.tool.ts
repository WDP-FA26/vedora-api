import { tool } from 'ai';
import { z } from 'zod';
import { NutritionPillar, RecipeTag } from '../../mongo/models.js';
import {
  MAX_GENERATE_EXCLUDES,
  MAX_GENERATE_MINUTES,
  MAX_GENERATE_QUERY_LENGTH,
} from '../dto/meal-plan.dto.js';
import type {
  MealPlanService,
  RecipeSuggestion,
} from '../meal-plan.service.js';
import { recipeSuggestionsOutput } from './output-schemas.js';

const PILLAR_LABELS: Record<NutritionPillar, string> = {
  [NutritionPillar.PLANT_PROTEIN]: 'Đạm TV',
  [NutritionPillar.FIBER_VEG]: 'Xơ',
  [NutritionPillar.HEALTHY_FAT]: 'Béo tốt',
  [NutritionPillar.IRON_RICH]: 'Giàu sắt',
  [NutritionPillar.CALCIUM_RICH]: 'Giàu canxi',
};

export function searchRecipesTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "List Vedora recipes. Recipes the user can eat come first; a recipe with an ingredient they avoid is still listed, marked AVOIDED with those ingredients, so you can answer questions about it, but never plan it. Without a query it returns the catalog; with one it matches titles, descriptions and ingredient names in Vietnamese, e.g. 'đậu hũ' or 'canh'. If a query finds nothing, call it again without one. Returns each recipe's id, title, tag, total minutes, approximate kcal/serving, plant nutrition pillars, ingredients and description.",
    inputSchema: z.object({
      query: z
        .string()
        .max(MAX_GENERATE_QUERY_LENGTH)
        .optional()
        .describe('A Vietnamese dish or ingredient name, with accents'),
      tag: z
        .enum(RecipeTag)
        .optional()
        .describe('Only dishes of this single type, e.g. SOUP or DRINK'),
      tags: z
        .array(z.enum(RecipeTag))
        .max(9)
        .optional()
        .describe('Only dishes having one of these types'),
      exclude: z
        .array(z.string().min(1).max(MAX_GENERATE_QUERY_LENGTH))
        .max(MAX_GENERATE_EXCLUDES)
        .optional()
        .describe(
          'Words a dish must not have in its title or ingredients, e.g. ["chiên"]',
        ),
      maxMinutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_GENERATE_MINUTES)
        .optional()
        .describe('Only dishes whose prep plus cook time is at most this'),
      maxCalories: z
        .number()
        .int()
        .min(50)
        .max(2000)
        .optional()
        .describe(
          'Only dishes with at most this approximate kcal per serving, e.g. 350 for a light dinner',
        ),
      pillar: z
        .enum(NutritionPillar)
        .optional()
        .describe(
          'Only dishes providing this plant-based nutrition pillar (PLANT_PROTEIN, FIBER_VEG, HEALTHY_FAT, IRON_RICH, CALCIUM_RICH)',
        ),
    }),
    outputSchema: recipeSuggestionsOutput,
    execute: ({ query, tag, tags, exclude, maxMinutes, maxCalories, pillar }) =>
      mealPlan.suggestions(userId, query, {
        tag,
        tags,
        exclude,
        maxMinutes,
        ...(maxCalories !== undefined ? { maxCalories } : {}),
        ...(pillar !== undefined ? { pillar } : {}),
      }),
    toModelOutput: ({ output }) => ({ type: 'text', value: lines(output) }),
  });
}

function lines(recipes: RecipeSuggestion[]): string {
  if (recipes.length === 0) return 'No recipes found.';
  return recipes
    .map(
      ({
        id,
        title,
        tag,
        minutes,
        caloriesPerServing,
        nutritionPillars,
        ingredients,
        description,
        avoidedIngredients,
      }) => {
        const parts = [
          id,
          title,
          tag ?? 'chưa phân loại',
          `${minutes === null ? '?' : minutes} phút`,
        ];
        if (typeof caloriesPerServing === 'number') {
          parts.push(`~${caloriesPerServing} kcal/suất`);
        }
        if (nutritionPillars && nutritionPillars.length > 0) {
          parts.push(
            nutritionPillars.map((item) => PILLAR_LABELS[item]).join(', '),
          );
        }
        parts.push(ingredients.join(', '));
        let line = parts.join(' | ');
        const note = description?.trim();
        if (note) line += ` | ${note}`;
        if (avoidedIngredients.length > 0) {
          line += ` | AVOIDED: ${avoidedIngredients.join(', ')}`;
        }
        return line;
      },
    )
    .join('\n');
}
