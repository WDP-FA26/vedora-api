import { runtimeConfig } from '../config/runtime-config.js';
import { rethrowAsStateConflict } from '../mongo/unique-conflict.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { HydratedDocument, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import {
  Ingredient,
  MealPlanDraftSlot,
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
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

type RecipeRow = Omit<Recipe, 'ingredients'> & {
  ingredients: (RecipeIngredient & { ingredient: Ingredient })[];
};
type DaySections = Record<MealSection, RecipeRow[]>;
type Week = Map<Weekday, DaySections>;
type RecipeRef = { id: string; title: string; tag: RecipeTag | null };

export interface SuggestionFilters {
  tag?: RecipeTag;
  tags?: RecipeTag[];
  exclude?: string[];
  maxMinutes?: number;
}

export interface RecipeSuggestion {
  id: string;
  title: string;
  tag: RecipeTag | null;
  minutes: number | null;
  ingredients: string[];
  description?: string | null;
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
/** The whole unsaved draft against the saved plan; `ok` only when it can be shown and saved. */
export type DraftProposal = MealPlanPreview & { ok: boolean };

const MAX_SUGGESTIONS = runtimeConfig.MEAL_PLAN_SUGGESTIONS_LIMIT;

type SlotKey = { day: Weekday; section: MealSection };

function hasFatalProblem(problems: readonly MealPlanProblemDto[]): boolean {
  return problems.some(
    (problem) =>
      problem.code === 'UNKNOWN_RECIPE' ||
      problem.code === 'AVOIDED_INGREDIENT',
  );
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
    @InjectModel(MealPlanDraftSlot.name)
    private readonly draftSlots: Model<MealPlanDraftSlot>,
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
      problems: await this.problems(userId, saved, {
        avoidedDays: WEEKDAYS,
        conflictSlots: allSlots(),
      }),
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
  }> {
    const [avoided, restrictions, rows] = await Promise.all([
      this.dietary.avoidedIngredientIds(userId),
      this.dietary.find(userId),
      this.recipeRows(await this.recipes.find().sort({ title: 1 }).exec()),
    ]);
    const ingredientsById = new Map(
      rows.map((recipe) => [recipe.id, ingredientIds(recipe)]),
    );
    const liked = new Set(restrictions.liked.map(({ id }) => id));
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
      candidates.push({
        id: recipe.id,
        title: recipe.title,
        tag: recipe.tag,
        minutes: totalMinutes(recipe),
        ingredientIds: ingredientIds(recipe),
        likedCount: recipe.ingredients.filter(({ ingredientId }) =>
          liked.has(ingredientId),
        ).length,
        matchesQuery: text !== '' && matchesQuery(recipe, text),
      });
    });

    return { candidates, ingredientsById };
  }

  /**
   * Picks dishes for the requested slots without an LLM and returns them as a
   * checked preview, like `preview`. Nothing is saved or added to the draft.
   */
  async generate(
    userId: string,
    dto: GenerateMealDaysDto,
  ): Promise<MealPlanPreview> {
    const [{ candidates, ingredientsById }, saved] = await Promise.all([
      this.buildGeneratorPool(userId, dto),
      this.saved(userId),
    ]);
    const savedIds = this.weekIds(saved);
    const { week, skip } = applyPinnedSlots(savedIds, dto.pinned);
    const tags = dto.tags && dto.tags.length > 0 ? dto.tags : null;

    const generated = await generateMealDays({
      candidates,
      saved: week,
      days: dto.days,
      sections: dto.sections,
      onlyEmpty: dto.onlyEmpty,
      perSection: dto.perSection ?? 1,
      ignoreFit: tags !== null,
      skip,
      ingredientsById,
      areCompatible: (sets) => this.areCompatible(sets),
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

  /**
   * Picks dishes for the requested slots without an LLM and lays them over
   * the unsaved draft; returns the whole draft checked like `preview`.
   */
  async fillDraft(
    userId: string,
    dto: GenerateMealDaysDto,
    extraPinned: readonly SlotKey[] = [],
  ): Promise<
    DraftProposal & { filled: number; allSlotsAlreadyFilled: boolean }
  > {
    const [{ candidates, ingredientsById }, { savedIds, ids }] =
      await Promise.all([
        this.buildGeneratorPool(userId, dto),
        this.effective(userId),
      ]);
    const { week: base, skip: dtoSkip } = applyPinnedSlots(ids, dto.pinned);
    const skip = [...dtoSkip, ...extraPinned];
    const targetSlots = dto.days.flatMap((day) =>
      dto.sections
        .filter(
          (section) =>
            !skip.some((slot) => slot.day === day && slot.section === section),
        )
        .map((section) => ({ day, section })),
    );
    const allSlotsAlreadyFilled =
      dto.onlyEmpty &&
      targetSlots.length > 0 &&
      targetSlots.every(
        ({ day, section }) => (base.get(day)?.[section].length ?? 0) > 0,
      );

    const tags = dto.tags && dto.tags.length > 0 ? dto.tags : null;
    const generated = await generateMealDays({
      candidates,
      saved: base,
      days: dto.days,
      sections: dto.sections,
      onlyEmpty: dto.onlyEmpty,
      perSection: dto.perSection ?? 1,
      ignoreFit: tags !== null,
      skip,
      ingredientsById,
      areCompatible: (sets) => this.areCompatible(sets),
      random: Math.random,
    });

    const next = cloneWeekIds(base);
    for (const { day, BREAKFAST, LUNCH, DINNER, OTHER } of generated) {
      next.set(day, { BREAKFAST, LUNCH, DINNER, OTHER });
    }
    const changed = changedSlots(next, ids, MEAL_SECTIONS).length;
    const filled = changed > 0 ? changed : generated.length > 0 ? 1 : 0;
    const proposal = await this.commitDraft(userId, next, savedIds);
    return { ...proposal, filled, allSlotsAlreadyFilled };
  }

  /** The unsaved draft the assistant is building, against the saved plan. */
  async getDraft(userId: string): Promise<DraftProposal> {
    const { savedIds, ids } = await this.effective(userId);
    return this.proposalFor(userId, ids, savedIds);
  }

  async discardDraft(userId: string): Promise<void> {
    await this.draftSlots.deleteMany({ userId }).exec();
  }

  /**
   * Applies slot operations to the draft and checks the whole result.
   * Non-fatal clashes stay in the draft so the caller can inspect and resolve
   * whichever slot fits the user's request.
   */
  async editDraft(
    userId: string,
    ops: DraftOp[],
  ): Promise<DraftProposal & { errors: string[] }> {
    const { savedIds, ids } = await this.effective(userId);
    const { week, errors } = applyDraftOps(ids, ops);
    const committed = await this.commitDraft(userId, week, savedIds);
    if (committed.problems.length === 0 && errors.length === 0) {
      return { ...committed, ok: true, errors };
    }
    return { ...committed, errors };
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

  /** The saved plan and the same plan with the draft laid over it. */
  private async effective(
    userId: string,
  ): Promise<{ savedIds: WeekIds; ids: WeekIds }> {
    const [saved, drafts] = await Promise.all([
      this.saved(userId),
      this.draftSlots.find({ userId }).exec(),
    ]);
    const savedIds = this.weekIds(saved);
    const ids = cloneWeekIds(savedIds);
    for (const slot of drafts) {
      const day = ids.get(slot.day);
      if (day) day[slot.section] = [...slot.recipeIds];
    }
    return { savedIds, ids };
  }

  private async proposalFor(
    userId: string,
    ids: WeekIds,
    savedIds: WeekIds,
  ): Promise<DraftProposal> {
    const changed = changedSlots(ids, savedIds, MEAL_SECTIONS);
    const days = WEEKDAYS.filter((day) =>
      changed.some((slot) => slot.day === day),
    );
    if (days.length === 0) return { days: [], problems: [], ok: false };

    const inputs: SaveMealDayDto[] = days.map((day) => {
      const slots = ids.get(day) ?? emptyWeekIds([day]).get(day);
      return {
        day,
        breakfast: slots?.BREAKFAST ?? [],
        lunch: slots?.LUNCH ?? [],
        dinner: slots?.DINNER ?? [],
        others: slots?.OTHER ?? [],
      };
    });
    const preview = await this.preview(userId, inputs);
    return { ...preview, ok: preview.problems.length === 0 };
  }

  private async commitDraft(
    userId: string,
    ids: WeekIds,
    savedIds: WeekIds,
  ): Promise<DraftProposal> {
    const proposal = await this.proposalFor(userId, ids, savedIds);
    if (hasFatalProblem(proposal.problems)) return proposal;

    await this.draftSlots.deleteMany({ userId }).exec();
    const changed = changedSlots(ids, savedIds, MEAL_SECTIONS);
    if (changed.length > 0) {
      await this.draftSlots.insertMany(
        changed.map((slot) => ({
          _id: randomUUID(),
          userId,
          ...slot,
          updatedAt: new Date(),
        })),
      );
    }
    return proposal;
  }

  async apply(userId: string, days: SaveMealDayDto[]): Promise<MealPlanDto> {
    const preview = await this.preview(userId, days);
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
      const appliedDays = preview.days.map(({ day }) => day);
      await this.entries
        .deleteMany({ userId, day: { $in: appliedDays } }, { session })
        .exec();
      await this.draftSlots
        .deleteMany({ userId, day: { $in: appliedDays } }, { session })
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
      const hasAvoided = recipe.ingredients.some(({ ingredientId }) =>
        avoided.has(ingredientId),
      );
      if (hasAvoided) continue;
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
      if (text !== '' && !matchesQuery(recipe, text, true)) continue;
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
        description: recipe.description,
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
