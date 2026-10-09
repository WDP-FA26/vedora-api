import { Injectable } from '@nestjs/common';
import { MealSection, Prisma, Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DietaryService } from '../recipes/dietary.service';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service';
import { conflict } from '../recipes/recipe-errors';
import {
  MEAL_SECTIONS,
  MealPlanDto,
  MealPlanProblemDto,
  MealRecipeDto,
  SaveMealDayDto,
  WEEKDAYS,
} from './dto/meal-plan.dto';

const recipeSelect = {
  id: true,
  title: true,
  imageUrl: true,
  servings: true,
  prepMinutes: true,
  cookMinutes: true,
  steps: true,
  ingredients: {
    select: {
      ingredientId: true,
      quantity: true,
      unit: true,
      note: true,
      ingredient: { select: { name: true } },
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.RecipeSelect;

type RecipeRow = Prisma.RecipeGetPayload<{ select: typeof recipeSelect }>;
type DaySections = Record<MealSection, RecipeRow[]>;
type Week = Map<Weekday, DaySections>;
type RecipeRef = { id: string; title: string };

export interface RecipeSuggestion {
  id: string;
  title: string;
  minutes: number | null;
  ingredients: string[];
}

/** Checked new content for some days, and what is wrong with it. */
export interface MealPlanPreview {
  days: {
    day: Weekday;
    sections: {
      section: MealSection;
      recipes: RecipeRef[];
      previous: RecipeRef[];
    }[];
  }[];
  problems: MealPlanProblemDto[];
}

const MAX_SUGGESTIONS = 30;

const emptyDay = (): DaySections => ({
  BREAKFAST: [],
  LUNCH: [],
  DINNER: [],
  OTHER: [],
});

const dishes = (day: DaySections | undefined): RecipeRow[] =>
  day ? MEAL_SECTIONS.flatMap((section) => day[section]) : [];

const toRef = ({ id, title }: RecipeRow): RecipeRef => ({ id, title });

/**
 * A user's weekly timetable: each day has breakfast, lunch, dinner and
 * "other", each an ordered list of dishes. Two rules are enforced on every
 * write: no ingredient the user avoids, and no incompatible ingredients
 * anywhere in one day.
 */
@Injectable()
export class MealPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dietary: DietaryService,
    private readonly rules: IncompatibilityRulesService,
  ) {}

  async find(userId: string): Promise<MealPlanDto> {
    const saved = await this.saved(userId);
    return {
      days: WEEKDAYS.map((day) => {
        const sections = saved.get(day) ?? emptyDay();
        return {
          day,
          sections: MEAL_SECTIONS.map((section) => ({
            section,
            recipes: sections[section].map(toRecipeDto),
          })),
        };
      }),
      problems: await this.problems(userId, saved, WEEKDAYS),
    };
  }

  /** What replacing the content of `days` would do, without saving. */
  async preview(
    userId: string,
    days: SaveMealDayDto[],
  ): Promise<MealPlanPreview> {
    const saved = await this.saved(userId);
    const requested = (day: SaveMealDayDto): Record<MealSection, string[]> => ({
      BREAKFAST: day.breakfast,
      LUNCH: day.lunch,
      DINNER: day.dinner,
      OTHER: day.others,
    });
    const recipes = await this.prisma.recipe.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              days.flatMap((day) => Object.values(requested(day)).flat()),
            ),
          ],
        },
      },
      select: recipeSelect,
    });
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

    const next: Week = new Map();
    const problems: MealPlanProblemDto[] = [];
    // only days that gain a dish are checked, so a dish can always be removed
    const daysToCheck: Weekday[] = [];
    for (const input of days) {
      const ids = requested(input);
      const sections = emptyDay();
      let unknown = false;
      for (const section of MEAL_SECTIONS) {
        for (const id of new Set(ids[section])) {
          const recipe = recipeById.get(id);
          if (recipe) sections[section].push(recipe);
          else unknown = true;
        }
      }
      if (unknown) {
        problems.push({
          code: 'UNKNOWN_RECIPE',
          day: input.day,
          recipes: [],
          ingredients: [],
          reason: null,
        });
      }
      const before = new Set(dishes(saved.get(input.day)).map(({ id }) => id));
      if (dishes(sections).some(({ id }) => !before.has(id))) {
        daysToCheck.push(input.day);
      }
      next.set(input.day, sections);
    }

    problems.push(...(await this.problems(userId, next, daysToCheck)));
    return {
      days: [...next].map(([day, sections]) => ({
        day,
        sections: MEAL_SECTIONS.map((section) => ({
          section,
          recipes: sections[section].map(toRef),
          previous: (saved.get(day)?.[section] ?? []).map(toRef),
        })),
      })),
      problems,
    };
  }

  async apply(userId: string, days: SaveMealDayDto[]): Promise<MealPlanDto> {
    const preview = await this.preview(userId, days);
    if (preview.problems.length > 0) {
      throw conflict(
        'MEAL_PLAN_INVALID',
        'These dishes break a dietary restriction or an incompatibility rule',
      );
    }
    await this.prisma.$transaction([
      this.prisma.mealPlanEntry.deleteMany({
        where: { userId, day: { in: preview.days.map(({ day }) => day) } },
      }),
      this.prisma.mealPlanEntry.createMany({
        data: preview.days.flatMap(({ day, sections }) =>
          sections.flatMap(({ section, recipes }) =>
            recipes.map(({ id }, position) => ({
              userId,
              day,
              section,
              recipeId: id,
              position,
            })),
          ),
        ),
      }),
    ]);
    return this.find(userId);
  }

  /** Recipes the user can eat: nothing avoided, no clash inside the recipe. */
  async suggestions(
    userId: string,
    query: string | undefined,
  ): Promise<RecipeSuggestion[]> {
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const text = query?.trim();
    const contains = { contains: text, mode: 'insensitive' } as const;
    const recipes = await this.prisma.recipe.findMany({
      where: {
        ingredients: { none: { ingredientId: { in: [...avoided] } } },
        ...(text
          ? {
              OR: [
                { title: contains },
                { description: contains },
                {
                  ingredients: {
                    some: {
                      ingredient: {
                        OR: [{ name: contains }, { aliases: { has: text } }],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      select: recipeSelect,
      orderBy: { title: 'asc' },
      take: MAX_SUGGESTIONS * 2,
    });
    const conflicts = await this.rules.findConflictsForEach(
      recipes.map(ingredientIds),
    );
    return recipes
      .filter((_, index) => conflicts[index].length === 0)
      .slice(0, MAX_SUGGESTIONS)
      .map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        minutes:
          recipe.prepMinutes === null && recipe.cookMinutes === null
            ? null
            : (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0),
        ingredients: recipe.ingredients.map(
          ({ ingredient }) => ingredient.name,
        ),
      }));
  }

  private async saved(userId: string): Promise<Week> {
    const rows = await this.prisma.mealPlanEntry.findMany({
      where: { userId },
      select: {
        day: true,
        section: true,
        recipe: { select: recipeSelect },
      },
      orderBy: { position: 'asc' },
    });
    const week: Week = new Map();
    for (const { day, section, recipe } of rows) {
      const sections = week.get(day) ?? emptyDay();
      sections[section].push(recipe);
      week.set(day, sections);
    }
    return week;
  }

  private async problems(
    userId: string,
    week: Week,
    days: readonly Weekday[],
  ): Promise<MealPlanProblemDto[]> {
    const checked = WEEKDAYS.filter((day) => days.includes(day)).flatMap(
      (day) => {
        // a dish in two sections of the day is one dish here
        const recipes = [...new Set(dishes(week.get(day)))];
        return recipes.length > 0 ? [{ day, recipes }] : [];
      },
    );
    if (checked.length === 0) return [];

    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const problems: MealPlanProblemDto[] = [];
    for (const { day, recipes } of checked) {
      for (const recipe of recipes) {
        const hits = recipe.ingredients.filter(({ ingredientId }) =>
          avoided.has(ingredientId),
        );
        if (hits.length > 0) {
          problems.push({
            code: 'AVOIDED_INGREDIENT',
            day,
            recipes: [recipe.title],
            ingredients: hits.map(({ ingredient }) => ingredient.name),
            reason: null,
          });
        }
      }
    }

    const conflicts = await this.rules.findConflictsForEach(
      checked.map(({ recipes }) => [
        ...new Set(recipes.flatMap(ingredientIds)),
      ]),
    );
    checked.forEach(({ day, recipes }, index) => {
      for (const { ingredientAId, ingredientBId, reason } of conflicts[index]) {
        const pair = [ingredientAId, ingredientBId];
        const using = recipes.filter((recipe) =>
          recipe.ingredients.some((item) => pair.includes(item.ingredientId)),
        );
        const name = (id: string) =>
          using
            .flatMap((recipe) => recipe.ingredients)
            .find((item) => item.ingredientId === id)?.ingredient.name ?? '';
        problems.push({
          code: 'DAY_CONFLICT',
          day,
          recipes: using.map(({ title }) => title),
          ingredients: pair.map(name),
          reason,
        });
      }
    });
    return problems;
  }
}

const ingredientIds = (recipe: RecipeRow) =>
  recipe.ingredients.map(({ ingredientId }) => ingredientId);

function toRecipeDto({ ingredients, ...rest }: RecipeRow): MealRecipeDto {
  return {
    ...rest,
    ingredients: ingredients.map(({ ingredient, quantity, unit, note }) => ({
      name: ingredient.name,
      quantity: quantity === null ? null : quantity.toNumber(),
      unit,
      note,
    })),
  };
}
