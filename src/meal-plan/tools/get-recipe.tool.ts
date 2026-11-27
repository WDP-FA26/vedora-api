import { tool } from 'ai';
import { z } from 'zod';
import { NutritionPillar } from '../../mongo/models.js';
import type {
  MealPlanService,
  RecipeInstructions,
} from '../meal-plan.service.js';

const PILLAR_LABELS: Record<NutritionPillar, string> = {
  [NutritionPillar.PLANT_PROTEIN]: 'Đạm thực vật',
  [NutritionPillar.FIBER_VEG]: 'Chất xơ & rau củ',
  [NutritionPillar.HEALTHY_FAT]: 'Chất béo tốt',
  [NutritionPillar.IRON_RICH]: 'Giàu sắt',
  [NutritionPillar.CALCIUM_RICH]: 'Giàu canxi',
};

export function getRecipeTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "Get one Vedora recipe's full details: description, servings, time, ingredients with quantities, and cooking steps. Use it when the user asks how to cook a dish or wants its ingredients or steps. Pass the exact id from getPlan, searchRecipes, or the current screen context.",
    inputSchema: z.object({
      recipeId: z.string().min(1).describe('A recipe id from searchRecipes'),
    }),
    execute: ({ recipeId }) => mealPlan.recipeInstructions(userId, recipeId),
    toModelOutput: ({ output }) => ({ type: 'text', value: format(output) }),
  });
}

type Ingredient = RecipeInstructions['ingredients'][number];

function format(recipe: RecipeInstructions | null): string {
  if (recipe === null) return 'Recipe not found.';

  const lines: string[] = [recipe.title];
  if (recipe.avoidedIngredients.length > 0) {
    lines.push(
      `AVOIDED: the user avoids ${recipe.avoidedIngredients.join(', ')}. Warn them before anything else, and never put this recipe in their plan.`,
    );
  }
  if (recipe.description !== null) {
    lines.push(recipe.description);
  }
  lines.push(formatSummary(recipe));

  lines.push('Nguyên liệu:');
  for (const ingredient of recipe.ingredients) {
    lines.push(formatIngredient(ingredient));
  }

  lines.push('Cách làm:');
  recipe.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });

  return lines.join('\n');
}

function formatSummary({
  servings,
  minutes,
  caloriesPerServing,
  nutritionPillars,
}: RecipeInstructions): string {
  const minutesText = minutes === null ? '?' : String(minutes);
  const parts = [`${servings} khẩu phần`, `${minutesText} phút`];
  if (typeof caloriesPerServing === 'number') {
    parts.push(`~${caloriesPerServing} kcal/suất`);
  }
  if (nutritionPillars && nutritionPillars.length > 0) {
    parts.push(nutritionPillars.map((item) => PILLAR_LABELS[item]).join(', '));
  }
  return parts.join(' | ');
}

function formatIngredient({ name, quantity, unit, note }: Ingredient): string {
  let line = `- ${name}`;

  const amountParts: string[] = [];
  if (quantity !== null) amountParts.push(String(quantity));
  if (unit !== null) amountParts.push(unit);
  if (amountParts.length > 0) {
    line += `: ${amountParts.join(' ')}`;
  }

  if (note !== null) {
    line += ` (${note})`;
  }
  return line;
}
