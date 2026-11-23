import { z } from 'zod';
import {
  CalorieSource,
  MealSection,
  NutritionPillar,
  RecipeTag,
  Weekday,
} from '../../mongo/models.js';

// Output schemas of the read-only planner tools. Code mode turns them into the
// TypeScript signatures the model codes against; the outputs themselves are
// passed through unchanged, so a schema may describe only the fields worth
// knowing about.

const pillars = z.array(z.enum(NutritionPillar)).optional();

export const recipeSuggestionsOutput = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    tag: z.enum(RecipeTag).nullable(),
    minutes: z.number().nullable().describe('Prep plus cook time'),
    caloriesPerServing: z.number().nullable().optional(),
    nutritionPillars: pillars,
    ingredients: z.array(z.string()),
    description: z.string().nullable().optional(),
    avoidedIngredients: z
      .array(z.string())
      .describe('Non-empty means the user avoids it: never plan this recipe'),
  }),
);

export const recipeInstructionsOutput = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    servings: z.number(),
    minutes: z.number().nullable(),
    caloriesPerServing: z.number().nullable().optional(),
    nutritionPillars: pillars,
    ingredients: z.array(
      z.object({
        name: z.string(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
    steps: z.array(z.string()),
    avoidedIngredients: z.array(z.string()),
  })
  .nullable()
  .describe('null when there is no such recipe');

export const planOutput = z.object({
  plan: z.object({
    weekStart: z.string(),
    today: z.string(),
    days: z.array(
      z.object({
        day: z.enum(Weekday),
        date: z.string(),
        editable: z.boolean().describe('false for a day before today'),
        sections: z.array(
          z.object({
            section: z.enum(MealSection),
            recipes: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                tag: z.enum(RecipeTag).nullable(),
                caloriesPerServing: z.number().nullable().optional(),
                nutritionPillars: pillars,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});

export const eatingLogOutput = z.object({
  log: z.object({
    weekStart: z.string(),
    today: z.string(),
    dailyCalorieTarget: z.number().nullable(),
    dailyCalorieMin: z.number().nullable(),
    dailyCalorieMax: z.number().nullable(),
    days: z.array(
      z.object({
        day: z.enum(Weekday),
        date: z.string(),
        loggable: z.boolean(),
        entries: z.array(
          z.object({
            section: z.enum(MealSection),
            name: z.string(),
            servings: z.number(),
            calories: z.number().nullable(),
            calorieSource: z
              .enum(CalorieSource)
              .nullable()
              .describe('WEB_ESTIMATE is an AI estimate, approximate'),
          }),
        ),
        loggedCalories: z.number(),
        unknownCalorieEntries: z.number(),
        plannedCalories: z.number().nullable(),
      }),
    ),
    summary: z.object({
      loggedDays: z.number(),
      completeDays: z.number(),
      averageCalories: z.number().nullable(),
      remainingDays: z.number(),
    }),
  }),
});
