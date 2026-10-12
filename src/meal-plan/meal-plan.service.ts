import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { MealSection, Prisma, Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DietaryService } from '../recipes/dietary.service';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service';
import {
  ingredientProblem,
  ingredientSafetySelect,
} from '../recipes/dietary-safety';
import { conflict, isSerializationConflict } from '../recipes/recipe-errors';
import { catalogWhere } from '../recipes/recipe-catalog.query';
import { RecipeCatalogQueryDto } from '../recipes/dto/recipe-catalog.dto';
import {
  MEAL_SECTIONS,
  MealPlanDto,
  MealPlanProblemDto,
  MealPlanPreviewDto,
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
      ingredient: { select: ingredientSafetySelect },
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
export type MealPlanPreview = MealPlanPreviewDto;

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

  async find(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MealPlanDto> {
    if (!tx)
      return this.prisma.$transaction((db) => this.find(userId, db), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    const saved = await this.saved(userId, tx);
    const profile = await this.dietary.find(userId, tx);
    const problems = await this.problems(userId, saved, WEEKDAYS, tx);
    return {
      dietaryVersion: profile.version,
      status: problems.length > 0 ? 'NEEDS_REVIEW' : 'VALID',
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
      problems,
    };
  }

  /** What replacing the content of `days` would do, without saving. */
  async preview(
    userId: string,
    days: SaveMealDayDto[],
    tx?: Prisma.TransactionClient,
    expectedVersion?: number,
  ): Promise<MealPlanPreview> {
    if (!tx)
      return this.prisma.$transaction(
        (db) => this.preview(userId, days, db, expectedVersion),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    const profile = await this.dietary.find(userId, tx);
    if (expectedVersion !== undefined && expectedVersion !== profile.version)
      throw conflict(
        'DIETARY_PROFILE_CHANGED',
        'Your profile changed; generate a new proposal',
      );
    const saved = await this.saved(userId, tx);
    const requested = (day: SaveMealDayDto): Record<MealSection, string[]> => ({
      BREAKFAST: day.breakfast,
      LUNCH: day.lunch,
      DINNER: day.dinner,
      OTHER: day.others,
    });
    const recipes = await tx.recipe.findMany({
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
    // Pure removals remain possible; all other changes are revalidated.
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
      const before = saved.get(input.day) ?? emptyDay();
      const after = dishes(sections);
      // A pure removal is always possible; reorder/move/keep must revalidate.
      if (
        after.length > 0 &&
        (after.length >= dishes(before).length ||
          !MEAL_SECTIONS.every((section) =>
            isSubsequence(sections[section], before[section]),
          ))
      ) {
        daysToCheck.push(input.day);
      }
      next.set(input.day, sections);
    }

    problems.push(...(await this.problems(userId, next, daysToCheck, tx)));
    return {
      dietaryVersion: profile.version,
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
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
          const preview = await this.preview(userId, days, tx);
          if (preview.problems.length > 0) {
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              error: 'Conflict',
              code: 'MEAL_PLAN_INVALID',
              message:
                'These dishes break a dietary restriction or an incompatibility rule',
              problems: preview.problems,
            });
          }
          await tx.mealPlanEntry.deleteMany({
            where: { userId, day: { in: preview.days.map(({ day }) => day) } },
          });
          await tx.mealPlanEntry.createMany({
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
          });
          return this.find(userId, tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationConflict(error))
        throw conflict(
          'MEAL_PLAN_CHANGED',
          'Your profile or meal data changed; reload and retry',
        );
      throw error;
    }
  }

  /** Recipes the user can eat: nothing avoided, no clash inside the recipe. */
  async suggestions(
    userId: string,
    query: string | undefined,
    expectedVersion?: number,
  ): Promise<RecipeSuggestion[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.dietary.assertReady(userId, tx, expectedVersion);
        const context = await this.dietary.context(userId, tx);
        const text = query?.trim();
        const where = catalogWhere(
          Object.assign(new RecipeCatalogQueryDto(), {
            q: text || undefined,
            suitableForMe: true,
          }),
          userId,
        );
        const ids = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT r.id FROM recipes r ${where} ORDER BY r.title ASC, r.id ASC LIMIT ${MAX_SUGGESTIONS}`,
        );
        const recipes = await tx.recipe.findMany({
          where: {
            id: { in: ids.map((row) => row.id) },
          },
          select: recipeSelect,
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
        });
        const conflicts = await this.rules.findConflictsForEach(
          recipes.map(ingredientIds),
          tx,
        );
        return recipes
          .filter(
            (recipe, index) =>
              conflicts[index].length === 0 &&
              recipe.ingredients.length > 0 &&
              recipe.ingredients.every(
                (item) =>
                  ingredientProblem(
                    item.ingredientId,
                    item.ingredient,
                    context,
                  ) === null,
              ),
          )
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async saved(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Week> {
    const rows = await tx.mealPlanEntry.findMany({
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
    tx: Prisma.TransactionClient,
  ): Promise<MealPlanProblemDto[]> {
    const checked = WEEKDAYS.filter((day) => days.includes(day)).flatMap(
      (day) => {
        // a dish in two sections of the day is one dish here
        const recipes = [...new Set(dishes(week.get(day)))];
        return recipes.length > 0 ? [{ day, recipes }] : [];
      },
    );
    if (checked.length === 0) return [];

    const profile = await this.dietary.find(userId, tx);
    const context = await this.dietary.context(userId, tx);
    const problems: MealPlanProblemDto[] = [];
    for (const { day, recipes } of checked) {
      if (!profile.readyForMealPlanning)
        problems.push({
          code: 'DIETARY_PROFILE_INCOMPLETE',
          day,
          recipes: recipes.map((recipe) => recipe.title),
          ingredients: [],
          reason: 'Confirm your allergy information',
        });
      for (const recipe of recipes) {
        if (recipe.ingredients.length === 0)
          problems.push({
            code: 'UNVERIFIED_INGREDIENT',
            day,
            recipes: [recipe.title],
            ingredients: [],
            reason: 'Recipe composition is missing',
          });
        for (const code of [
          'AVOIDED_INGREDIENT',
          'UNVERIFIED_INGREDIENT',
          'ALLERGEN_INFORMATION_INCOMPLETE',
        ] as const) {
          const hits = recipe.ingredients.filter(
            (item) =>
              ingredientProblem(item.ingredientId, item.ingredient, context) ===
              code,
          );
          if (hits.length > 0) {
            problems.push({
              code,
              day,
              recipes: [recipe.title],
              ingredients: hits.map(({ ingredient }) => ingredient.name),
              reason: null,
            });
          }
        }
      }
    }

    const conflicts = await this.rules.findConflictsForEach(
      checked.map(({ recipes }) => [
        ...new Set(recipes.flatMap(ingredientIds)),
      ]),
      tx,
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

function isSubsequence(next: RecipeRow[], before: RecipeRow[]): boolean {
  let index = 0;
  for (const recipe of before) if (next[index]?.id === recipe.id) index++;
  return index === next.length;
}

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
