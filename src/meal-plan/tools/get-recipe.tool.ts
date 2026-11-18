import { tool } from 'ai';
import { z } from 'zod';
import type {
  MealPlanService,
  RecipeInstructions,
} from '../meal-plan.service.js';

export function getRecipeTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "Get one Vedora recipe's full details: description, servings, time, ingredients with quantities, and cooking steps. Use it when the user asks how to cook a dish or wants its ingredients or steps. Pass the exact id returned by searchRecipes.",
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

function formatSummary({ servings, minutes }: RecipeInstructions): string {
  const minutesText = minutes === null ? '?' : String(minutes);
  return `${servings} khẩu phần | ${minutesText} phút`;
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
