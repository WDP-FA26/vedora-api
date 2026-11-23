import { runtimeConfig } from '../config/runtime-config.js';
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
  NutritionGoal,
  NutritionPillar,
  Recipe,
  RecipeIngredient,
  RecipeTag,
  User,
  Weekday,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { allExist } from '../mongo/references.js';
import { DietaryService } from '../recipes/dietary.service.js';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service.js';
import {
  extractAllergyKeywords,
  inferNutritionPillars,
  resolveCaloriesPerServing,
} from '../recipes/nutrition.js';
import {
  MEAL_SECTIONS,
  MealPlanDto,
  GenerateMealDaysDto,
  MealPlanProblemDto,
  MealPlanPreviewDto,
  MealRecipeDto,
  SaveMealDayDto,
  SlotRefDto,
  WEEKDAYS,
} from './dto/meal-plan.dto.js';
import {
  generateMealDays,
  type GeneratorCandidate,
} from './meal-plan-generator.js';
import {
  applyDraftOps,
  changedSlots,
  cloneWeekIds,
  emptyWeekIds,
  type DraftOp,
  type WeekIds,
} from './meal-plan-draft.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import {
  assertDaysEditable,
  assertWithinHorizon,
  currentMealWeek,
  type MealWeek,
} from './meal-week.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

type RecipeRow = Omit<Recipe, 'ingredients'> & {
  ingredients: (RecipeIngredient & { ingredient: Ingredient })[];
};
type DaySections = Record<MealSection, RecipeRow[]>;
type Week = Map<Weekday, DaySections>;
type RecipeRef = {
  id: string;
  title: string;
  tag: RecipeTag | null;
  caloriesPerServing: number;
  nutritionPillars: NutritionPillar[];
};

export interface SuggestionFilters {
  tag?: RecipeTag;
  tags?: RecipeTag[];
  exclude?: string[];
  maxMinutes?: number;
  maxCalories?: number;
  pillar?: NutritionPillar;
}

export interface RecipeSuggestion {
  id: string;
  title: string;
  tag: RecipeTag | null;
  minutes: number | null;
  caloriesPerServing?: number | null;
  nutritionPillars?: NutritionPillar[];
  ingredients: string[];
  description?: string | null;
  /** Ingredients the user avoids. The recipe can be discussed but never planned. */
  avoidedIngredients: string[];
}

export interface RecipeInstructions {
  id: string;
  title: string;
  description: string | null;
  servings: number;
  minutes: number | null;
  caloriesPerServing?: number | null;
  nutritionPillars?: NutritionPillar[];
  ingredients: {
    name: string;
    quantity: number | null;
    unit: string | null;
    note: string | null;
  }[];
  steps: string[];
  /** Ingredients the user avoids. The recipe can be discussed but never planned. */
  avoidedIngredients: string[];
}

export type MealPlanPreview = MealPlanPreviewDto;
/**
 * What an assistant tool changed in the saved plan: each changed day with all
 * four sections, before (`previous`) and after (`recipes`). `applied` is false
 * when nothing was saved (no change, or an unknown or avoided dish).
 */
export type PlanChange = MealPlanPreview & { applied: boolean };

function noChange(weekStart: string): PlanChange {
  return { weekStart, days: [], problems: [], applied: false };
}

const MAX_SUGGESTIONS = runtimeConfig.MEAL_PLAN_SUGGESTIONS_LIMIT;

type SlotKey = { day: Weekday; section: MealSection };

/** A dish that no longer exists or that the user avoids can never be saved. */
function isBlockingProblem(problem: MealPlanProblemDto): boolean {
  return (
    problem.code === 'UNKNOWN_RECIPE' || problem.code === 'AVOIDED_INGREDIENT'
  );
}

function hasFatalProblem(problems: readonly MealPlanProblemDto[]): boolean {
  return problems.some(isBlockingProblem);
}

function blockedRecipeIds(
  problems: readonly MealPlanProblemDto[],
): Set<string> {
  const blocked = new Set<string>();
  for (const problem of problems) {
    if (!isBlockingProblem(problem)) continue;
    for (const id of problem.recipeIds) blocked.add(id);
  }
  return blocked;
}

function withoutRecipes(week: WeekIds, blocked: ReadonlySet<string>): WeekIds {
  const kept = cloneWeekIds(week);
  for (const slots of kept.values()) {
    for (const section of MEAL_SECTIONS) {
      slots[section] = slots[section].filter((id) => !blocked.has(id));
    }
  }
  return kept;
}

function applyPinnedSlots(
  base: WeekIds,
  pinned: readonly SlotRefDto[] | undefined,
): { week: WeekIds; skip: SlotKey[] } {
  const week = cloneWeekIds(base);
  const skip: SlotKey[] = [];
  for (const pin of pinned ?? []) {
    skip.push({ day: pin.day, section: pin.section });
    if (pin.recipeIds === undefined) continue;
    const daySlots = week.get(pin.day);
    if (daySlots) daySlots[pin.section] = [...pin.recipeIds];
  }
  return { week, skip };
}

const emptyDay = (): DaySections => ({
  BREAKFAST: [],
  LUNCH: [],
  DINNER: [],
  OTHER: [],
});

const allSlots = (): SlotKey[] =>
  WEEKDAYS.flatMap((day) => MEAL_SECTIONS.map((section) => ({ day, section })));

const dishes = (day: DaySections | undefined): RecipeRow[] =>
  day ? MEAL_SECTIONS.flatMap((section) => day[section]) : [];

/** The request without the days that have passed, and the pins on them. */
function onlyEditable(
  dto: GenerateMealDaysDto,
  week: MealWeek,
): GenerateMealDaysDto {
  const pinned = (dto.pinned ?? []).filter(({ day }) =>
    week.editableDays.includes(day),
  );
  return {
    ...dto,
    days: dto.days.filter((day) => week.editableDays.includes(day)),
    pinned: dto.pinned === undefined ? undefined : pinned,
  };
}

const toRef = (recipe: RecipeRow): RecipeRef => ({
  id: recipe.id,
  title: recipe.title,
  tag: recipe.tag,
  ...recipeNutrition(recipe),
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

  /** The saved plan of one week; the current week when `weekStart` is left out. */
  async find(userId: string, weekStart?: string): Promise<MealPlanDto> {
    const week = currentMealWeek(weekStart);
    assertWithinHorizon(week);
    return this.toPlan(userId, week, await this.saved(userId, week.weekStart));
  }

  /** The earliest week to browse back to: the first one with a dish, or the current week. */
  private async minWeekStart(userId: string, week: MealWeek): Promise<string> {
    const first = await this.entries
      .findOne({ userId })
      .sort({ weekStart: 1 })
      .exec();
    if (!first || first.weekStart > week.currentWeekStart) {
      return week.currentWeekStart;
    }
    return first.weekStart;
  }

  private async toPlan(
    userId: string,
    week: MealWeek,
    saved: Week,
  ): Promise<MealPlanDto> {
    return {
      weekStart: week.weekStart,
      currentWeekStart: week.currentWeekStart,
      today: week.today,
      maxWeekStart: week.maxWeekStart,
      minWeekStart: await this.minWeekStart(userId, week),
      editable: week.editableDays.length > 0,
      days: WEEKDAYS.map((day) => {
        const sections = saved.get(day) ?? emptyDay();
        return {
          day,
          date: week.dates[day],
          editable: week.editableDays.includes(day),
          sections: MEAL_SECTIONS.map((section) => ({
            section,
            recipes: sections[section].map(toRecipeDto),
          })),
        };
      }),
      problems: await this.problems(userId, saved, {
        avoidedDays: week.editableDays,
        conflictSlots: allSlots().filter(({ day }) =>
          week.editableDays.includes(day),
        ),
      }),
    };
  }

  async preview(
    userId: string,
    weekStart: string,
    days: SaveMealDayDto[],
  ): Promise<MealPlanPreview> {
    const week = currentMealWeek(weekStart);
    assertDaysEditable(
      week,
      days.map(({ day }) => day),
    );
    const saved = await this.saved(userId, week.weekStart);
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
    const slotsToCheck: SlotKey[] = [];
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
      for (const section of MEAL_SECTIONS) {
        const inMeal = new Set(
          (saved.get(input.day)?.[section] ?? []).map(({ id }) => id),
        );
        if (sections[section].some(({ id }) => !inMeal.has(id))) {
          slotsToCheck.push({ day: input.day, section });
        }
      }
      next.set(input.day, sections);
    }

    problems.push(
      ...(await this.problems(userId, next, {
        avoidedDays: daysToCheck,
        conflictSlots: slotsToCheck,
      })),
    );
    return {
      weekStart: week.weekStart,
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

  private async areCompatible(sets: string[][]): Promise<boolean[]> {
    const conflicts = await this.rules.findConflictsForEach(sets);
    return conflicts.map((found) => found.length === 0);
  }

  private async buildGeneratorPool(
    userId: string,
    dto: Pick<
      GenerateMealDaysDto,
      'query' | 'exclude' | 'tags' | 'candidateIds' | 'avoidIds' | 'maxMinutes'
    >,
  ): Promise<{
    candidates: GeneratorCandidate[];
    ingredientsById: Map<string, string[]>;
    caloriesById: Map<string, number>;
    nutritionGoal: NutritionGoal | null;
    dailyCalorieTarget: number | null;
  }> {
    const [avoided, restrictions, nutrition, rows] = await Promise.all([
      this.dietary.avoidedIngredientIds(userId),
      this.dietary.find(userId),
      Promise.resolve(this.dietary.findNutrition(userId)).then(
        (value) => value ?? null,
      ),
      this.recipeRows(await this.recipes.find().sort({ title: 1 }).exec()),
    ]);
    const ingredientsById = new Map<string, string[]>();
    const caloriesById = new Map<string, number>();
    for (const recipe of rows) {
      ingredientsById.set(recipe.id, ingredientIds(recipe));
      caloriesById.set(recipe.id, recipeNutrition(recipe).caloriesPerServing);
    }
    const allergyKeywords = extractAllergyKeywords(restrictions.allergyNote);
    const text = dto.query?.trim().toLowerCase() ?? '';
    const excluded = (dto.exclude ?? [])
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== '');
    const tags = dto.tags && dto.tags.length > 0 ? dto.tags : null;
    const allowed = dto.candidateIds ? new Set(dto.candidateIds) : null;
    const denied = new Set(dto.avoidIds ?? []);

    const eligible: RecipeRow[] = [];
    for (const recipe of rows) {
      const hasAvoided = recipe.ingredients.some(({ ingredientId }) =>
        avoided.has(ingredientId),
      );
      if (hasAvoided) continue;
      if (allergyKeywords.some((word) => matchesText(recipe, word, true))) {
        continue;
      }
      if (allowed && !allowed.has(recipe.id)) continue;
      if (denied.has(recipe.id)) continue;
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
      const nutritionMeta = recipeNutrition(recipe);
      candidates.push({
        id: recipe.id,
        title: recipe.title,
        tag: recipe.tag,
        minutes: totalMinutes(recipe),
        caloriesPerServing: nutritionMeta.caloriesPerServing,
        nutritionPillars: nutritionMeta.nutritionPillars,
        ingredientIds: ingredientIds(recipe),
        matchesQuery: text !== '' && matchesQuery(recipe, text),
      });
    });

    return {
      candidates,
      ingredientsById,
      caloriesById,
      nutritionGoal: nutrition?.effectiveGoal ?? null,
      dailyCalorieTarget: nutrition?.dailyCalorieTarget ?? null,
    };
  }

  /**
   * Picks dishes for the requested slots without an LLM and returns them as a
   * checked preview, like `preview`. Nothing is saved or added to the draft.
   */
  async generate(
    userId: string,
    dto: GenerateMealDaysDto,
  ): Promise<MealPlanPreview> {
    const week = currentMealWeek(dto.weekStart);
    assertWithinHorizon(week);
    const request = onlyEditable(dto, week);
    if (request.days.length === 0) {
      return { weekStart: week.weekStart, days: [], problems: [] };
    }
    const [
      { candidates, ingredientsById, nutritionGoal, dailyCalorieTarget },
      saved,
    ] = await Promise.all([
      this.buildGeneratorPool(userId, request),
      this.saved(userId, week.weekStart),
    ]);
    const savedIds = this.weekIds(saved);
    const { week: base, skip } = applyPinnedSlots(savedIds, request.pinned);
    const tags = request.tags && request.tags.length > 0 ? request.tags : null;

    const generated = await generateMealDays({
      candidates,
      saved: base,
      days: request.days,
      sections: request.sections,
      onlyEmpty: request.onlyEmpty,
      perSection: request.perSection ?? 1,
      ignoreFit: tags !== null,
      nutritionGoal,
      dailyCalorieTarget: dto.targetCalories ?? dailyCalorieTarget,
      skip,
      ingredientsById,
      areCompatible: (sets) => this.areCompatible(sets),
      random: Math.random,
    });
    if (generated.length === 0) {
      return { weekStart: week.weekStart, days: [], problems: [] };
    }

    return this.preview(
      userId,
      week.weekStart,
      generated.map(({ day, BREAKFAST, LUNCH, DINNER, OTHER }) => ({
        day,
        breakfast: BREAKFAST,
        lunch: LUNCH,
        dinner: DINNER,
        others: OTHER,
      })),
    );
  }

  /**
   * Picks dishes for the requested slots without an LLM and saves them into
   * the plan straight away; returns what changed, checked like `preview`.
   */
  async fillPlan(
    userId: string,
    dto: GenerateMealDaysDto,
    extraPinned: readonly SlotKey[] = [],
  ): Promise<PlanChange & { filled: number; allSlotsAlreadyFilled: boolean }> {
    const week = currentMealWeek(dto.weekStart);
    assertWithinHorizon(week);
    const request = onlyEditable(dto, week);
    if (request.days.length === 0) {
      return {
        ...noChange(week.weekStart),
        filled: 0,
        allSlotsAlreadyFilled: false,
      };
    }
    const [
      { candidates, ingredientsById, nutritionGoal, dailyCalorieTarget },
      savedIds,
    ] = await Promise.all([
      this.buildGeneratorPool(userId, request),
      this.savedWeekIds(userId, week),
    ]);
    const { week: base, skip: dtoSkip } = applyPinnedSlots(
      savedIds,
      request.pinned,
    );
    const skip = [...dtoSkip, ...extraPinned];
    const targetSlots = request.days.flatMap((day) =>
      request.sections
        .filter(
          (section) =>
            !skip.some((slot) => slot.day === day && slot.section === section),
        )
        .map((section) => ({ day, section })),
    );
    const allSlotsAlreadyFilled =
      request.onlyEmpty &&
      targetSlots.length > 0 &&
      targetSlots.every(
        ({ day, section }) => (base.get(day)?.[section].length ?? 0) > 0,
      );

    const tags = request.tags && request.tags.length > 0 ? request.tags : null;
    const generated = await generateMealDays({
      candidates,
      saved: base,
      days: request.days,
      sections: request.sections,
      onlyEmpty: request.onlyEmpty,
      perSection: request.perSection ?? 1,
      ignoreFit: tags !== null,
      nutritionGoal,
      dailyCalorieTarget: dto.targetCalories ?? dailyCalorieTarget,
      skip,
      ingredientsById,
      areCompatible: (sets) => this.areCompatible(sets),
      random: Math.random,
    });

    const next = cloneWeekIds(base);
    for (const { day, BREAKFAST, LUNCH, DINNER, OTHER } of generated) {
      next.set(day, { BREAKFAST, LUNCH, DINNER, OTHER });
    }
    const changed = changedSlots(next, savedIds, MEAL_SECTIONS).length;
    let filled = 0;
    if (changed > 0) filled = changed;
    else if (generated.length > 0) filled = 1;
    const change = await this.commitChange(userId, week, next, savedIds);
    return { ...change, filled, allSlotsAlreadyFilled };
  }

  /**
   * Balances editable days toward the target calorie budget and saves the
   * result: trims extra dishes on over-budget days and adds complementary
   * dishes on under-budget days while keeping existing choices.
   */
  async autoBalancePlan(
    userId: string,
    options: {
      weekStart?: string;
      days?: Weekday[];
      targetCalories?: number;
    } = {},
  ): Promise<PlanChange & { filled: number; targetCalories: number }> {
    const week = currentMealWeek(options.weekStart);
    assertWithinHorizon(week);
    const [
      {
        candidates,
        ingredientsById,
        caloriesById,
        nutritionGoal,
        dailyCalorieTarget,
      },
      savedIds,
    ] = await Promise.all([
      this.buildGeneratorPool(userId, {}),
      this.savedWeekIds(userId, week),
    ]);
    const resolvedTarget = options.targetCalories ?? dailyCalorieTarget ?? 1800;
    const requestedDays =
      options.days && options.days.length > 0
        ? options.days
        : week.editableDays;
    const targetDays = requestedDays.filter((day) =>
      week.editableDays.includes(day),
    );
    if (targetDays.length === 0) {
      return {
        ...noChange(week.weekStart),
        filled: 0,
        targetCalories: resolvedTarget,
      };
    }

    const base = cloneWeekIds(savedIds);
    const ceiling = Math.round(resolvedTarget * 1.15);
    for (const day of targetDays) {
      const slots = base.get(day);
      if (!slots) continue;
      trimExcessDayDishes(slots, caloriesById, ceiling);
    }

    const generated = await generateMealDays({
      candidates,
      saved: base,
      days: targetDays,
      sections: MEAL_SECTIONS,
      onlyEmpty: true,
      perSection: 1,
      ignoreFit: false,
      nutritionGoal,
      dailyCalorieTarget: resolvedTarget,
      skip: [],
      ingredientsById,
      areCompatible: (sets) => this.areCompatible(sets),
      random: Math.random,
    });

    const next = cloneWeekIds(base);
    for (const { day, BREAKFAST, LUNCH, DINNER, OTHER } of generated) {
      next.set(day, { BREAKFAST, LUNCH, DINNER, OTHER });
    }
    const changed = changedSlots(next, savedIds, MEAL_SECTIONS).length;
    const change = await this.commitChange(userId, week, next, savedIds);
    return { ...change, filled: changed, targetCalories: resolvedTarget };
  }

  /**
   * Applies slot operations to the saved plan. An operation that cannot apply
   * is reported in `errors` and skipped; an unknown or avoided dish keeps the
   * whole change from being saved.
   */
  async editPlan(
    userId: string,
    weekStart: string,
    ops: DraftOp[],
  ): Promise<PlanChange & { errors: string[] }> {
    const mealWeek = currentMealWeek(weekStart);
    assertWithinHorizon(mealWeek);
    const savedIds = await this.savedWeekIds(userId, mealWeek);
    const locked = WEEKDAYS.filter(
      (day) => !mealWeek.editableDays.includes(day),
    );
    const { week, errors } = applyDraftOps(savedIds, ops, locked);
    const change = await this.commitChange(userId, mealWeek, week, savedIds);
    return { ...change, errors };
  }

  /**
   * Puts days back the way they were (the rewind of an assistant turn). Days
   * that have passed since cannot change and are returned as `skipped`; a dish
   * that has been deleted or is now avoided is left out and counted in
   * `droppedDishes`, so one stale dish never blocks the rest of the rewind.
   */
  async restoreDays(
    userId: string,
    weekStart: string,
    days: SaveMealDayDto[],
  ): Promise<{
    restored: Weekday[];
    skipped: Weekday[];
    droppedDishes: number;
  }> {
    const week = currentMealWeek(weekStart);
    const editable: SaveMealDayDto[] = [];
    const skipped: Weekday[] = [];
    for (const day of days) {
      if (week.editableDays.includes(day.day)) editable.push(day);
      else skipped.push(day.day);
    }
    if (editable.length === 0) {
      return { restored: [], skipped, droppedDishes: 0 };
    }

    const preview = await this.preview(userId, week.weekStart, editable);
    const blocked = blockedRecipeIds(preview.problems);
    let droppedDishes = 0;
    const keep = (ids: string[]): string[] => {
      const kept = ids.filter((id) => !blocked.has(id));
      droppedDishes += ids.length - kept.length;
      return kept;
    };
    const restore: SaveMealDayDto[] = editable.map((day) => ({
      day: day.day,
      breakfast: keep(day.breakfast),
      lunch: keep(day.lunch),
      dinner: keep(day.dinner),
      others: keep(day.others),
    }));
    await this.apply(userId, week.weekStart, restore);
    return { restored: restore.map(({ day }) => day), skipped, droppedDishes };
  }

  private weekIds(week: Week): WeekIds {
    const ids = emptyWeekIds(WEEKDAYS);
    for (const [day, sections] of week) {
      const slots = ids.get(day);
      if (!slots) continue;
      for (const section of MEAL_SECTIONS) {
        slots[section] = sections[section].map(({ id }) => id);
      }
    }
    return ids;
  }

  private async savedWeekIds(userId: string, week: MealWeek): Promise<WeekIds> {
    return this.weekIds(await this.saved(userId, week.weekStart));
  }

  /**
   * Saves the days where `next` differs from the saved plan. A dish that is
   * unknown or avoided refuses the whole change; a same-day clash is saved and
   * listed in `problems`, as with `PUT /meal-plan/days`.
   */
  private async commitChange(
    userId: string,
    week: MealWeek,
    next: WeekIds,
    savedIds: WeekIds,
  ): Promise<PlanChange> {
    const preview = await this.previewChange(userId, week, next, savedIds);
    if (!preview) return noChange(week.weekStart);
    const blocked = blockedRecipeIds(preview.problems);
    if (blocked.size === 0) {
      await this.writeDays(userId, week, preview);
      return { ...preview, applied: true };
    }

    // A dish that no longer exists or that the user avoids is left out; the
    // rest of the change is still saved, and the problems say what was dropped.
    const leftOut = preview.problems.filter(isBlockingProblem);
    const kept = await this.previewChange(
      userId,
      week,
      withoutRecipes(next, blocked),
      savedIds,
    );
    if (!kept) return { ...preview, applied: false };
    await this.writeDays(userId, week, kept);
    return {
      ...kept,
      problems: [...leftOut, ...kept.problems],
      applied: true,
    };
  }

  /** Previews the days where `next` differs from what is saved, or null when none does. */
  private async previewChange(
    userId: string,
    week: MealWeek,
    next: WeekIds,
    savedIds: WeekIds,
  ): Promise<MealPlanPreview | null> {
    const changed = changedSlots(next, savedIds, MEAL_SECTIONS);
    const days = WEEKDAYS.filter((day) =>
      changed.some((slot) => slot.day === day),
    );
    if (days.length === 0) return null;

    const inputs: SaveMealDayDto[] = days.map((day) => {
      const slots = next.get(day);
      return {
        day,
        breakfast: slots?.BREAKFAST ?? [],
        lunch: slots?.LUNCH ?? [],
        dinner: slots?.DINNER ?? [],
        others: slots?.OTHER ?? [],
      };
    });
    return this.preview(userId, week.weekStart, inputs);
  }

  async apply(
    userId: string,
    weekStart: string,
    days: SaveMealDayDto[],
    options: { requireEmptyDays?: boolean } = {},
  ): Promise<MealPlanDto> {
    const week = currentMealWeek(weekStart);
    const preview = await this.preview(userId, week.weekStart, days);
    // A DAY_CONFLICT is a warning: the user may still choose to eat these
    // together, and it comes back in `MealPlanDto.problems`. Only a dish the
    // user avoids or one that no longer exists is refused.
    if (hasFatalProblem(preview.problems)) {
      throw new StateConflictException(
        'MEAL_PLAN_INVALID',
        'These dishes break a dietary restriction or no longer exist',
        {
          problems: preview.problems.filter(
            (problem) => problem.code !== 'DAY_CONFLICT',
          ),
        },
      );
    }
    return this.writeDays(userId, week, preview, options);
  }

  /** Replaces the days of `preview` in the saved plan, all or nothing. */
  private async writeDays(
    userId: string,
    week: MealWeek,
    preview: MealPlanPreview,
    options: { requireEmptyDays?: boolean } = {},
  ): Promise<MealPlanDto> {
    const entries = preview.days.flatMap(({ day, sections }) =>
      sections.flatMap(({ section, recipes }) =>
        recipes.map(({ id }, position) => ({
          _id: randomUUID(),
          userId,
          weekStart: week.weekStart,
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
      // The preview checked the dishes outside this transaction; lock them
      // (as recipe deletion does) and check again, so a dish deleted in
      // between is refused instead of saved as a dangling entry.
      const recipeIds = [...new Set(entries.map(({ recipeId }) => recipeId))];
      for (const recipeId of recipeIds.sort()) {
        await lockDocument(this.mongo, session, 'recipe', recipeId);
      }
      if (!(await allExist(this.recipes, recipeIds, session))) {
        throw new StateConflictException(
          'MEAL_PLAN_INVALID',
          'These dishes break a dietary restriction or no longer exist',
        );
      }
      const appliedDays = preview.days.map(({ day }) => day);
      if (options.requireEmptyDays) {
        const taken = await this.entries
          .countDocuments(
            { userId, weekStart: week.weekStart, day: { $in: appliedDays } },
            { session },
          )
          .exec();
        if (taken > 0) {
          throw new StateConflictException(
            'MEAL_WEEK_NOT_EMPTY',
            'The target week already has dishes; pass overwrite to replace them',
            { weekStart: week.weekStart },
          );
        }
      }
      await this.entries
        .deleteMany(
          { userId, weekStart: week.weekStart, day: { $in: appliedDays } },
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
        .find({ userId, weekStart: week.weekStart })
        .sort({ position: 1 })
        .session(session)
        .exec();
    });
    return this.toPlan(userId, week, await this.weekOf(saved));
  }

  /**
   * Copies the dishes of one week onto the days of another that may still
   * change. The target must be empty on those days unless `overwrite` is set,
   * and the whole copy is saved or refused together.
   */
  async copyWeek(
    userId: string,
    fromWeekStart: string,
    toWeekStart: string,
    overwrite: boolean,
  ): Promise<MealPlanDto> {
    if (fromWeekStart === toWeekStart) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Choose a different week to copy from',
      );
    }
    const target = currentMealWeek(toWeekStart);
    assertWithinHorizon(target);
    const source = currentMealWeek(fromWeekStart);
    const sourcePlan = await this.saved(userId, source.weekStart);
    const days: SaveMealDayDto[] = target.editableDays.map((day) => {
      const sections = sourcePlan.get(day) ?? emptyDay();
      return {
        day,
        breakfast: sections.BREAKFAST.map(({ id }) => id),
        lunch: sections.LUNCH.map(({ id }) => id),
        dinner: sections.DINNER.map(({ id }) => id),
        others: sections.OTHER.map(({ id }) => id),
      };
    });
    if (days.length === 0) {
      throw new StateConflictException(
        'MEAL_DAY_LOCKED',
        'Every day of this week has passed',
        { weekStart: target.weekStart, days: [], today: target.today },
      );
    }
    return this.apply(userId, target.weekStart, days, {
      requireEmptyDays: !overwrite,
    });
  }

  async suggestions(
    userId: string,
    query: string | undefined,
    filters: SuggestionFilters = {},
  ): Promise<RecipeSuggestion[]> {
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const text = query?.trim().toLowerCase() ?? '';
    const excluded = (filters.exclude ?? [])
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== '');
    const allowedTags =
      filters.tags && filters.tags.length > 0 ? filters.tags : null;
    const rows = await this.recipeRows(
      await this.recipes.find().sort({ title: 1 }).exec(),
    );

    const matching: RecipeRow[] = [];
    for (const recipe of rows) {
      if (filters.tag !== undefined && recipe.tag !== filters.tag) continue;
      if (
        allowedTags !== null &&
        (recipe.tag === null || !allowedTags.includes(recipe.tag))
      ) {
        continue;
      }
      if (excluded.some((word) => matchesText(recipe, word))) continue;
      if (filters.maxMinutes !== undefined) {
        const minutes = totalMinutes(recipe);
        if (minutes === null || minutes > filters.maxMinutes) continue;
      }
      const nutritionMeta = recipeNutrition(recipe);
      if (
        filters.maxCalories !== undefined &&
        nutritionMeta.caloriesPerServing > filters.maxCalories
      ) {
        continue;
      }
      if (
        filters.pillar !== undefined &&
        !nutritionMeta.nutritionPillars.includes(filters.pillar)
      ) {
        continue;
      }
      if (text !== '' && !matchesQuery(recipe, text, true)) continue;
      matching.push(recipe);
      if (matching.length === MAX_SUGGESTIONS * 2) break;
    }

    const conflicts = await this.rules.findConflictsForEach(
      matching.map(ingredientIds),
    );
    // Recipes with an avoided ingredient stay searchable, so the assistant can
    // answer questions about them, but come after the ones the user can eat.
    const edible: RecipeSuggestion[] = [];
    const flagged: RecipeSuggestion[] = [];
    matching.forEach((recipe, index) => {
      if (conflicts[index].length > 0) return;
      const nutritionMeta = recipeNutrition(recipe);
      const suggestion: RecipeSuggestion = {
        id: recipe.id,
        title: recipe.title,
        tag: recipe.tag,
        minutes: totalMinutes(recipe),
        caloriesPerServing: nutritionMeta.caloriesPerServing,
        nutritionPillars: nutritionMeta.nutritionPillars,
        ingredients: recipe.ingredients.map(
          ({ ingredient }) => ingredient.name,
        ),
        description: recipe.description,
        avoidedIngredients: avoidedNames(recipe, avoided),
      };
      if (suggestion.avoidedIngredients.length > 0) flagged.push(suggestion);
      else edible.push(suggestion);
    });
    return [...edible, ...flagged].slice(0, MAX_SUGGESTIONS);
  }

  /** Full recipe for one id, null when it is missing. Avoided ingredients are flagged, not hidden. */
  async recipeInstructions(
    userId: string,
    recipeId: string,
  ): Promise<RecipeInstructions | null> {
    const row = await this.recipes.findOne({ _id: recipeId }).exec();
    if (!row) return null;
    const [recipe] = await this.recipeRows([row]);
    const avoided = await this.dietary.avoidedIngredientIds(userId);
    const hasTime = recipe.prepMinutes !== null || recipe.cookMinutes !== null;
    const nutritionMeta = recipeNutrition(recipe);
    return {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      servings: recipe.servings,
      minutes: hasTime
        ? (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0)
        : null,
      caloriesPerServing: nutritionMeta.caloriesPerServing,
      nutritionPillars: nutritionMeta.nutritionPillars,
      ingredients: recipe.ingredients.map(
        ({ ingredient, quantity, unit, note }) => ({
          name: ingredient.name,
          quantity,
          unit,
          note,
        }),
      ),
      steps: recipe.steps,
      avoidedIngredients: avoidedNames(recipe, avoided),
    };
  }

  private async saved(userId: string, weekStart: string): Promise<Week> {
    return this.weekOf(
      await this.entries
        .find({ userId, weekStart })
        .sort({ position: 1 })
        .exec(),
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

  /**
   * An avoided ingredient is checked per day a dish was added to; two
   * incompatible ingredients are checked per meal (one slot), so a dish in
   * lunch never clashes with one in dinner.
   */
  private async problems(
    userId: string,
    week: Week,
    checked: {
      avoidedDays: readonly Weekday[];
      conflictSlots: readonly SlotKey[];
    },
  ): Promise<MealPlanProblemDto[]> {
    const problems: MealPlanProblemDto[] = [];

    const avoidedDays = WEEKDAYS.filter((day) =>
      checked.avoidedDays.includes(day),
    ).flatMap((day) => {
      const recipes = [...new Set(dishes(week.get(day)))];
      return recipes.length > 0 ? [{ day, recipes }] : [];
    });
    if (avoidedDays.length > 0) {
      const avoided = await this.dietary.avoidedIngredientIds(userId);
      for (const { day, recipes } of avoidedDays) {
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
    }

    const meals: { day: Weekday; recipes: RecipeRow[] }[] = [];
    for (const day of WEEKDAYS) {
      for (const section of MEAL_SECTIONS) {
        const isChecked = checked.conflictSlots.some(
          (slot) => slot.day === day && slot.section === section,
        );
        if (!isChecked) continue;
        const recipes = [...new Set(week.get(day)?.[section] ?? [])];
        if (recipes.length > 0) meals.push({ day, recipes });
      }
    }
    if (meals.length === 0) return problems;

    const conflicts = await this.rules.findConflictsForEach(
      meals.map(({ recipes }) => [...new Set(recipes.flatMap(ingredientIds))]),
    );
    meals.forEach(({ day, recipes }, index) => {
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
      ingredient.aliases.some((alias) => alias.toLowerCase().includes(text)),
  );
}

function matchesQuery(
  recipe: RecipeRow,
  text: string,
  includeDescription = false,
): boolean {
  if (matchesText(recipe, text, includeDescription)) return true;
  const words = text.split(/\s+/).filter((word) => word !== '');
  return (
    words.length > 1 &&
    words.every((word) => matchesText(recipe, word, includeDescription))
  );
}

const ingredientIds = (recipe: RecipeRow) =>
  recipe.ingredients.map(({ ingredientId }) => ingredientId);

function recipeNutrition(recipe: RecipeRow): {
  caloriesPerServing: number;
  nutritionPillars: NutritionPillar[];
} {
  const ingredientNames = recipe.ingredients.map(
    ({ ingredient }) => ingredient.name,
  );
  return {
    caloriesPerServing: resolveCaloriesPerServing({
      caloriesPerServing: recipe.caloriesPerServing,
      tag: recipe.tag,
      title: recipe.title,
      ingredientNames,
    }),
    nutritionPillars: inferNutritionPillars(
      ingredientNames,
      recipe.nutritionPillars ?? [],
    ),
  };
}

function toRecipeDto(recipe: RecipeRow): MealRecipeDto {
  const { caloriesPerServing, nutritionPillars } = recipeNutrition(recipe);
  return {
    id: recipe.id,
    title: recipe.title,
    imageUrl: recipe.imageUrl,
    tag: recipe.tag,
    servings: recipe.servings,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    caloriesPerServing,
    nutritionPillars,
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

/** Names of the recipe's ingredients that the user avoids, in recipe order. */
function avoidedNames(
  recipe: RecipeRow,
  avoided: ReadonlySet<string>,
): string[] {
  const names: string[] = [];
  for (const { ingredientId, ingredient } of recipe.ingredients) {
    if (avoided.has(ingredientId)) names.push(ingredient.name);
  }
  return names;
}

const TRIM_SECTIONS: readonly {
  section: MealSection;
  minDishes: number;
}[] = [
  { section: MealSection.OTHER, minDishes: 0 },
  { section: MealSection.DINNER, minDishes: 1 },
  { section: MealSection.LUNCH, minDishes: 1 },
  { section: MealSection.BREAKFAST, minDishes: 1 },
];

function trimExcessDayDishes(
  slots: Record<MealSection, string[]>,
  caloriesById: ReadonlyMap<string, number>,
  ceiling: number,
): void {
  let total = MEAL_SECTIONS.reduce(
    (sum, section) =>
      sum +
      slots[section].reduce(
        (slotSum, id) => slotSum + (caloriesById.get(id) ?? 0),
        0,
      ),
    0,
  );
  if (total <= ceiling) return;

  for (const { section, minDishes } of TRIM_SECTIONS) {
    while (total > ceiling && slots[section].length > minDishes) {
      const removed = slots[section].pop();
      if (!removed) break;
      total -= caloriesById.get(removed) ?? 0;
    }
    if (total <= ceiling) break;
  }
}
