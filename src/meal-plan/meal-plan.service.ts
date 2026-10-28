import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { HydratedDocument, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock';
import {
  Ingredient,
  MealPlanEntry,
  MealSection,
  Recipe,
  RecipeIngredient,
  Stored,
  User,
  Weekday,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { DietaryService } from '../recipes/dietary.service';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service';
import {
  MEAL_SECTIONS,
  MealPlanDto,
  MealPlanProblemDto,
  MealPlanPreviewDto,
  MealRecipeDto,
  SaveMealDayDto,
  WEEKDAYS,
} from './dto/meal-plan.dto';

/** A recipe with its ingredients, by position, and their names. */
type RecipeRow = Recipe & {
  ingredients: (RecipeIngredient & { ingredient: Ingredient })[];
};
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
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeIngredient.name)
    private readonly recipeIngredients: Model<RecipeIngredient>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    private readonly dietary: DietaryService,
    private readonly rules: IncompatibilityRulesService,
    private readonly mongo: MongoService,
  ) {}

  async find(userId: string): Promise<MealPlanDto> {
    return this.toPlan(userId, await this.saved(userId));
  }

  private async toPlan(userId: string, saved: Week): Promise<MealPlanDto> {
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
    const recipes = await this.recipeRows(
      await this.recipes
        .find({
          _id: {
            $in: [
              ...new Set(
                days.flatMap((day) => Object.values(requested(day)).flat()),
              ),
            ],
          },
        })
        .exec(),
    );
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

    const next: Week = new Map();
    const problems: MealPlanProblemDto[] = [];
    // only days that gain a dish are checked, so a dish can always be removed
    const daysToCheck: Weekday[] = [];
    for (const input of days) {
      const ids = requested(input);
      const sections = emptyDay();
      const unknown = new Set<string>();
      for (const section of MEAL_SECTIONS) {
        for (const id of new Set(ids[section])) {
          const recipe = recipeById.get(id);
          if (recipe) sections[section].push(recipe);
          else unknown.add(id);
        }
      }
      if (unknown.size > 0) {
        problems.push({
          code: 'UNKNOWN_RECIPE',
          day: input.day,
          recipes: [],
          recipeIds: [...unknown],
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
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'MEAL_PLAN_INVALID',
        message:
          'These dishes break a dietary restriction or an incompatibility rule',
        problems: preview.problems,
      });
    }
    const entries = preview.days.flatMap(({ day, sections }) =>
      sections.flatMap(({ section, recipes }) =>
        recipes.map(({ id }, position) => ({
          _id: randomUUID(),
          userId,
          day,
          section,
          recipeId: id,
          position,
        })),
      ),
    );
    const { db } = this.mongo;
    // The days are replaced as a whole: their old entries and the new ones
    // change together.
    const saved = await this.mongo.withTransaction(async (session) => {
      await lockDocument(db, session, 'user', userId);
      const user = await db
        .collection<Stored<User>>('users')
        .findOne({ _id: userId }, { session });
      if (!user) throw new NotFoundException('User not found');
      const planned = db.collection<Stored<MealPlanEntry>>('meal_plan_entries');
      await planned.deleteMany(
        { userId, day: { $in: preview.days.map(({ day }) => day) } },
        { session },
      );
      // insertMany rejects an empty list (a day saved empty).
      if (entries.length > 0) await planned.insertMany(entries, { session });
      // The timetable as this save left it, not as a following save leaves it.
      return planned
        .find({ userId }, { session })
        .sort({ position: 1 })
        .toArray();
    });
    return this.toPlan(userId, await this.weekOf(saved));
  }

  /** Recipes the user can eat: nothing avoided, no clash inside the recipe. */
  async suggestions(
    userId: string,
    query: string | undefined,
  ): Promise<RecipeSuggestion[]> {
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const text = query?.trim().toLowerCase();
    const includesText = (value: string | null) =>
      !!text && !!value?.toLowerCase().includes(text);
    // MongoDB has no relation filters, so the recipes are filtered by their
    // ingredients here. The catalog is admin-curated and small.
    const recipes = (
      await this.recipeRows(await this.recipes.find().sort({ title: 1 }).exec())
    )
      .filter(({ ingredients }) =>
        ingredients.every(({ ingredientId }) => !avoided.has(ingredientId)),
      )
      .filter(
        (recipe) =>
          !text ||
          includesText(recipe.title) ||
          includesText(recipe.description) ||
          recipe.ingredients.some(
            ({ ingredient }) =>
              includesText(ingredient.name) ||
              ingredient.aliases.includes(text),
          ),
      )
      .slice(0, MAX_SUGGESTIONS * 2);
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
    const entries =
      this.mongo.db.collection<Stored<MealPlanEntry>>('meal_plan_entries');
    return this.weekOf(
      await entries.find({ userId }).sort({ position: 1 }).toArray(),
    );
  }

  /** The timetable of `rows`, by day and section, in their order. */
  private async weekOf(
    rows: Pick<MealPlanEntry, 'day' | 'section' | 'recipeId'>[],
  ): Promise<Week> {
    const recipes = await this.recipeRows(
      await this.recipes
        .find({ _id: { $in: [...new Set(rows.map((row) => row.recipeId))] } })
        .exec(),
    );
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const week: Week = new Map();
    for (const { day, section, recipeId } of rows) {
      const recipe = recipeById.get(recipeId);
      if (!recipe) continue;
      const sections = week.get(day) ?? emptyDay();
      sections[section].push(recipe);
      week.set(day, sections);
    }
    return week;
  }

  /** Adds each recipe's ingredients, by position, with their names. */
  private async recipeRows(
    recipes: HydratedDocument<Recipe>[],
  ): Promise<RecipeRow[]> {
    const items = await this.recipeIngredients
      .find({ recipeId: { $in: recipes.map(({ id }) => id) } })
      .sort({ position: 1 })
      .exec();
    const ingredientIds = [
      ...new Set(items.map(({ ingredientId }) => ingredientId)),
    ];
    const ingredients = await this.ingredients
      .find({ _id: { $in: ingredientIds } })
      .exec();
    const ingredientById = new Map(
      ingredients.map((ingredient) => [ingredient.id, ingredient]),
    );
    return recipes.map((recipe) => ({
      ...(recipe.toObject() as Recipe),
      id: recipe.id,
      ingredients: items
        .filter(({ recipeId }) => recipeId === recipe.id)
        .flatMap((item) => {
          const ingredient = ingredientById.get(item.ingredientId);
          return ingredient
            ? [
                Object.assign(item.toObject() as RecipeIngredient, {
                  ingredient,
                }),
              ]
            : [];
        }),
    }));
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
            recipeIds: [recipe.id],
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
          recipeIds: using.map(({ id }) => id),
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

function toRecipeDto(recipe: RecipeRow): MealRecipeDto {
  return {
    id: recipe.id,
    title: recipe.title,
    imageUrl: recipe.imageUrl,
    servings: recipe.servings,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    steps: [...recipe.steps],
    ingredients: recipe.ingredients.map(
      ({ ingredient, quantity, unit, note }) => ({
        name: ingredient.name,
        quantity,
        unit,
        note,
      }),
    ),
  };
}
