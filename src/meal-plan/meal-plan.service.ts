import { rethrowAsStateConflict } from '../mongo/unique-conflict.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { HydratedDocument, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import {
  Ingredient,
  MealPlanEntry,
  MealSection,
  Recipe,
  RecipeIngredient,
  RecipeTag,
  User,
  Weekday,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { DietaryService } from '../recipes/dietary.service.js';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service.js';
import {
  MEAL_SECTIONS,
  MealPlanDto,
  GenerateMealDaysDto,
  MealPlanProblemDto,
  MealPlanPreviewDto,
  MealRecipeDto,
  SaveMealDayDto,
  WEEKDAYS,
} from './dto/meal-plan.dto.js';
import {
  generateMealDays,
  type GeneratorCandidate,
  type SlotRecipeIds,
} from './meal-plan-generator.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

type RecipeRow = Omit<Recipe, 'ingredients'> & {
  ingredients: (RecipeIngredient & { ingredient: Ingredient })[];
};
type DaySections = Record<MealSection, RecipeRow[]>;
type Week = Map<Weekday, DaySections>;
type RecipeRef = { id: string; title: string; tag: RecipeTag | null };

export interface SuggestionFilters {
  tag?: RecipeTag;
  maxMinutes?: number;
}

export interface RecipeSuggestion {
  id: string;
  title: string;
  tag: RecipeTag | null;
  minutes: number | null;
  ingredients: string[];
}

export interface RecipeInstructions {
  id: string;
  title: string;
  description: string | null;
  servings: number;
  minutes: number | null;
  ingredients: {
    name: string;
    quantity: number | null;
    unit: string | null;
    note: string | null;
  }[];
  steps: string[];
}

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

const toRef = ({ id, title, tag }: RecipeRow): RecipeRef => ({
  id,
  title,
  tag,
});

@Injectable()
export class MealPlanService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(MealPlanEntry.name)
    private readonly entries: Model<MealPlanEntry>,
    @InjectModel(User.name) private readonly users: Model<User>,
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

  /**
   * Picks dishes for the requested slots without an LLM and returns them as a
   * checked preview, like `preview`. Nothing is saved.
   */
  async generate(
    userId: string,
    dto: GenerateMealDaysDto,
  ): Promise<MealPlanPreview> {
    const [avoided, restrictions, saved] = await Promise.all([
      this.dietary.avoidedIngredientIds(userId),
      this.dietary.find(userId),
      this.saved(userId),
    ]);
    const liked = new Set(restrictions.liked.map(({ id }) => id));
    const text = dto.query?.trim().toLowerCase() ?? '';
    const excluded = (dto.exclude ?? [])
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== '');
    const tags = dto.tags && dto.tags.length > 0 ? dto.tags : null;

    const rows = await this.recipeRows(
      await this.recipes.find().sort({ title: 1 }).exec(),
    );
    const eligible: RecipeRow[] = [];
    for (const recipe of rows) {
      const hasAvoided = recipe.ingredients.some(({ ingredientId }) =>
        avoided.has(ingredientId),
      );
      if (hasAvoided) continue;
      if (tags && (recipe.tag === null || !tags.includes(recipe.tag))) continue;
      if (excluded.some((word) => matchesText(recipe, word))) continue;
      if (dto.maxMinutes !== undefined) {
        const minutes = totalMinutes(recipe);
        if (minutes === null || minutes > dto.maxMinutes) continue;
      }
      eligible.push(recipe);
    }
    const ownConflicts = await this.rules.findConflictsForEach(
      eligible.map(ingredientIds),
    );
    const candidates: GeneratorCandidate[] = [];
    eligible.forEach((recipe, index) => {
      if (ownConflicts[index].length > 0) return;
      candidates.push({
        id: recipe.id,
        title: recipe.title,
        tag: recipe.tag,
        minutes: totalMinutes(recipe),
        ingredientIds: ingredientIds(recipe),
        likedCount: recipe.ingredients.filter(({ ingredientId }) =>
          liked.has(ingredientId),
        ).length,
        matchesQuery: text !== '' && matchesText(recipe, text),
      });
    });

    const savedIds = new Map<Weekday, SlotRecipeIds>();
    for (const [day, sections] of saved) {
      savedIds.set(day, {
        BREAKFAST: sections.BREAKFAST.map(({ id }) => id),
        LUNCH: sections.LUNCH.map(({ id }) => id),
        DINNER: sections.DINNER.map(({ id }) => id),
        OTHER: sections.OTHER.map(({ id }) => id),
      });
    }

    const generated = await generateMealDays({
      candidates,
      saved: savedIds,
      days: dto.days,
      sections: dto.sections,
      onlyEmpty: dto.onlyEmpty,
      perSection: dto.perSection ?? 1,
      ignoreFit: tags !== null,
      areCompatible: async (sets) => {
        const conflicts = await this.rules.findConflictsForEach(sets);
        return conflicts.map((found) => found.length === 0);
      },
      random: Math.random,
    });
    if (generated.length === 0) return { days: [], problems: [] };

    return this.preview(
      userId,
      generated.map(({ day, BREAKFAST, LUNCH, DINNER, OTHER }) => ({
        day,
        breakfast: BREAKFAST,
        lunch: LUNCH,
        dinner: DINNER,
        others: OTHER,
      })),
    );
  }

  async apply(userId: string, days: SaveMealDayDto[]): Promise<MealPlanDto> {
    const preview = await this.preview(userId, days);
    if (preview.problems.length > 0) {
      throw new StateConflictException(
        'MEAL_PLAN_INVALID',
        'These dishes break a dietary restriction or an incompatibility rule',
        { problems: preview.problems },
      );
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
    const saved = await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', userId);
      const user = await this.users
        .findOne({ _id: userId })
        .session(session)
        .exec();
      if (!user)
        throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
      await this.entries
        .deleteMany(
          { userId, day: { $in: preview.days.map(({ day }) => day) } },
          { session },
        )
        .exec();
      if (entries.length > 0) {
        await this.entries
          .insertMany(entries, { session })
          .catch((error: unknown) =>
            rethrowAsStateConflict(
              error,
              'MEAL_PLAN_CONFLICT',
              'The meal plan changed; reload it and save again',
            ),
          );
      }
      return this.entries
        .find({ userId })
        .sort({ position: 1 })
        .session(session)
        .exec();
    });
    return this.toPlan(userId, await this.weekOf(saved));
  }

  async suggestions(
    userId: string,
    query: string | undefined,
    filters: SuggestionFilters = {},
  ): Promise<RecipeSuggestion[]> {
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const text = query?.trim().toLowerCase() ?? '';
    const rows = await this.recipeRows(
      await this.recipes.find().sort({ title: 1 }).exec(),
    );

    const matching: RecipeRow[] = [];
    for (const recipe of rows) {
      const hasAvoided = recipe.ingredients.some(({ ingredientId }) =>
        avoided.has(ingredientId),
      );
      if (hasAvoided) continue;
      if (filters.tag !== undefined && recipe.tag !== filters.tag) continue;
      if (filters.maxMinutes !== undefined) {
        const minutes = totalMinutes(recipe);
        if (minutes === null || minutes > filters.maxMinutes) continue;
      }
      if (text !== '' && !matchesText(recipe, text, true)) continue;
      matching.push(recipe);
      if (matching.length === MAX_SUGGESTIONS * 2) break;
    }

    const conflicts = await this.rules.findConflictsForEach(
      matching.map(ingredientIds),
    );
    const suggestions: RecipeSuggestion[] = [];
    matching.forEach((recipe, index) => {
      if (conflicts[index].length > 0) return;
      if (suggestions.length === MAX_SUGGESTIONS) return;
      suggestions.push({
        id: recipe.id,
        title: recipe.title,
        tag: recipe.tag,
        minutes: totalMinutes(recipe),
        ingredients: recipe.ingredients.map(
          ({ ingredient }) => ingredient.name,
        ),
      });
    });
    return suggestions;
  }

  /** Full recipe for one id; null when it is missing or has an ingredient the user avoids. */
  async recipeInstructions(
    userId: string,
    recipeId: string,
  ): Promise<RecipeInstructions | null> {
    const row = await this.recipes.findOne({ _id: recipeId }).exec();
    if (!row) return null;
    const [recipe] = await this.recipeRows([row]);
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const hasAvoided = recipe.ingredients.some(({ ingredientId }) =>
      avoided.has(ingredientId),
    );
    if (hasAvoided) return null;
    const hasTime = recipe.prepMinutes !== null || recipe.cookMinutes !== null;
    return {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      servings: recipe.servings,
      minutes: hasTime
        ? (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0)
        : null,
      ingredients: recipe.ingredients.map(
        ({ ingredient, quantity, unit, note }) => ({
          name: ingredient.name,
          quantity,
          unit,
          note,
        }),
      ),
      steps: recipe.steps,
    };
  }

  private async saved(userId: string): Promise<Week> {
    return this.weekOf(
      await this.entries.find({ userId }).sort({ position: 1 }).exec(),
    );
  }

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

  private async recipeRows(
    recipes: HydratedDocument<Recipe>[],
  ): Promise<RecipeRow[]> {
    const ingredientIds = [
      ...new Set(
        recipes.flatMap((recipe) =>
          recipe.ingredients.map(({ ingredientId }) => ingredientId),
        ),
      ),
    ];
    const ingredients = await this.ingredients
      .find({ _id: { $in: ingredientIds } })
      .exec();
    const ingredientById = new Map(
      ingredients.map((ingredient) => [ingredient.id, ingredient]),
    );
    return recipes.map((recipe) => {
      const plain = recipe.toObject() as Recipe;
      return {
        ...plain,
        id: recipe.id,
        ingredients: plain.ingredients.flatMap((item) => {
          const ingredient = ingredientById.get(item.ingredientId);
          return ingredient ? [{ ...item, ingredient }] : [];
        }),
      };
    });
  }

  private async problems(
    userId: string,
    week: Week,
    days: readonly Weekday[],
  ): Promise<MealPlanProblemDto[]> {
    const checked = WEEKDAYS.filter((day) => days.includes(day)).flatMap(
      (day) => {
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

function totalMinutes(recipe: RecipeRow): number | null {
  if (recipe.prepMinutes === null && recipe.cookMinutes === null) return null;
  return (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
}

function matchesText(
  recipe: RecipeRow,
  text: string,
  includeDescription = false,
): boolean {
  if (recipe.title.toLowerCase().includes(text)) return true;
  if (includeDescription && recipe.description?.toLowerCase().includes(text)) {
    return true;
  }
  return recipe.ingredients.some(
    ({ ingredient }) =>
      ingredient.name.toLowerCase().includes(text) ||
      ingredient.aliases.includes(text),
  );
}

const ingredientIds = (recipe: RecipeRow) =>
  recipe.ingredients.map(({ ingredientId }) => ingredientId);

function toRecipeDto(recipe: RecipeRow): MealRecipeDto {
  return {
    id: recipe.id,
    title: recipe.title,
    imageUrl: recipe.imageUrl,
    tag: recipe.tag,
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
