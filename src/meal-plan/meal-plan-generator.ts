import {
  MealSection,
  NutritionGoal,
  NutritionPillar,
  RecipeTag,
  Weekday,
} from '../mongo/models.js';

/** A recipe the user may eat, reduced to what the generator ranks on. */
export interface GeneratorCandidate {
  id: string;
  title: string;
  tag: RecipeTag | null;
  minutes: number | null;
  caloriesPerServing?: number | null;
  nutritionPillars?: readonly NutritionPillar[];
  ingredientIds: string[];
  /** How many of the user's liked ingredients the recipe uses. */
  likedCount: number;
  /** Whether the recipe matches the free-text wish of the request. */
  matchesQuery: boolean;
}

export type SlotRecipeIds = Record<MealSection, string[]>;

export interface GeneratorInput {
  candidates: GeneratorCandidate[];
  /** What is saved today, so repeats and same-day clashes are seen. */
  saved: ReadonlyMap<Weekday, SlotRecipeIds>;
  days: readonly Weekday[];
  sections: readonly MealSection[];
  /** Slots that must stay exactly as they are. */
  skip: readonly { day: Weekday; section: MealSection }[];
  /** Keep every slot that already has a dish. */
  onlyEmpty: boolean;
  /** How many dishes each filled slot gets. */
  perSection: number;
  /** Skip the tag-to-meal fit, e.g. when the user asked for specific tags. */
  ignoreFit: boolean;
  /** Optional BMI goal & daily calorie target to steer dish selection naturally. */
  nutritionGoal?: NutritionGoal | null;
  dailyCalorieTarget?: number | null;
  /** Ingredients for every recipe id (including saved/pinned dishes outside candidates). */
  ingredientsById?: ReadonlyMap<string, readonly string[]>;
  /** One answer per ingredient set: true when no two ingredients clash. */
  areCompatible: (ingredientSets: string[][]) => Promise<boolean[]>;
  /** Returns [0, 1); injected so tests are deterministic. */
  random: () => number;
}

export type GeneratedDay = { day: Weekday } & SlotRecipeIds;

const MAIN_MEALS: readonly MealSection[] = [
  MealSection.BREAKFAST,
  MealSection.LUNCH,
  MealSection.DINNER,
];

const FITS: Record<MealSection, readonly RecipeTag[]> = {
  [MealSection.BREAKFAST]: [RecipeTag.BREAD, RecipeTag.NOODLES, RecipeTag.SOUP],
  [MealSection.LUNCH]: [
    RecipeTag.RICE,
    RecipeTag.STIR_FRY,
    RecipeTag.NOODLES,
    RecipeTag.SALAD,
    RecipeTag.SOUP,
  ],
  [MealSection.DINNER]: [
    RecipeTag.RICE,
    RecipeTag.STIR_FRY,
    RecipeTag.SOUP,
    RecipeTag.SALAD,
  ],
  [MealSection.OTHER]: [RecipeTag.SNACK, RecipeTag.DRINK, RecipeTag.DESSERT],
};

const NOT_FOR_MAIN_MEALS: readonly RecipeTag[] = [
  RecipeTag.DRINK,
  RecipeTag.DESSERT,
  RecipeTag.SNACK,
];

// A dish may appear in different meals (lunch and dinner), but never twice in
// the same meal across the week unless nothing else is left.
const SAME_MEAL_REPEAT_PENALTY = 100;
const SAME_DAY_REPEAT_PENALTY = 40;
const REPEAT_PENALTY = 2;
const FIT_BONUS = 4;
const MISFIT_PENALTY = 6;
const QUERY_BONUS = 5;
const LIKED_BONUS = 1.5;
const PROTEIN_NEEDED_BONUS = 2.5;
const PILLAR_NEEDED_BONUS = 1.0;
const SHORTLIST_SIZE = 8;

const CALORIE_FLOOR_RATIO = 0.88;
const CALORIE_CEILING_RATIO = 1.15;

const EXPANSION_STEPS: readonly { section: MealSection; maxDishes: number }[] =
  [
    { section: MealSection.LUNCH, maxDishes: 2 },
    { section: MealSection.DINNER, maxDishes: 2 },
    { section: MealSection.OTHER, maxDishes: 1 },
    { section: MealSection.LUNCH, maxDishes: 3 },
    { section: MealSection.DINNER, maxDishes: 3 },
    { section: MealSection.BREAKFAST, maxDishes: 2 },
    { section: MealSection.OTHER, maxDishes: 2 },
  ];

const LIGHT_TAGS: readonly RecipeTag[] = [RecipeTag.SOUP, RecipeTag.SALAD];
const HEARTY_TAGS: readonly RecipeTag[] = [
  RecipeTag.RICE,
  RecipeTag.NOODLES,
  RecipeTag.STIR_FRY,
  RecipeTag.BREAD,
];
const SINGULAR_MAIN_TAGS: readonly RecipeTag[] = [
  RecipeTag.SOUP,
  RecipeTag.RICE,
  RecipeTag.NOODLES,
  RecipeTag.BREAD,
];

function mealCompositionScore(
  recipe: GeneratorCandidate,
  section: MealSection,
  slotIds: readonly string[],
  byId: ReadonlyMap<string, GeneratorCandidate>,
): number {
  if (slotIds.length === 0 || recipe.tag === null) return 0;
  const existingTags = slotIds
    .map((id) => byId.get(id)?.tag ?? null)
    .filter((tag): tag is RecipeTag => tag !== null);

  if (existingTags.includes(recipe.tag)) {
    return SINGULAR_MAIN_TAGS.includes(recipe.tag) ? -8 : -3;
  }
  if (section !== MealSection.LUNCH && section !== MealSection.DINNER) {
    return 0;
  }
  const hasHearty = existingTags.some((tag) => HEARTY_TAGS.includes(tag));
  const hasSoup = existingTags.includes(RecipeTag.SOUP);
  if (hasHearty && recipe.tag === RecipeTag.SOUP) return 3.5;
  if (
    hasSoup &&
    (recipe.tag === RecipeTag.RICE || recipe.tag === RecipeTag.STIR_FRY)
  ) {
    return 3.5;
  }
  if (
    (hasHearty || hasSoup) &&
    (recipe.tag === RecipeTag.SALAD || recipe.tag === RecipeTag.STIR_FRY)
  ) {
    return 3;
  }
  return 0;
}

function nutritionFitScore(
  recipe: GeneratorCandidate,
  section: MealSection,
  goal: NutritionGoal | null | undefined,
  dayCalories: number,
  dailyTarget: number | null | undefined,
  slotIds: readonly string[],
  byId: ReadonlyMap<string, GeneratorCandidate>,
): number {
  let score = mealCompositionScore(recipe, section, slotIds, byId);
  const kcal = recipe.caloriesPerServing ?? null;
  const pillars = recipe.nutritionPillars ?? [];

  if (goal === NutritionGoal.LOSE_WEIGHT) {
    if (section === MealSection.DINNER) {
      if (
        (kcal !== null && kcal <= 280) ||
        (recipe.tag !== null && LIGHT_TAGS.includes(recipe.tag))
      ) {
        score += 3;
      } else if (kcal !== null && kcal >= 420) {
        score -= 3.5;
      }
    }
    if (pillars.includes(NutritionPillar.PLANT_PROTEIN)) score += 1;
    if (pillars.includes(NutritionPillar.FIBER_VEG)) score += 1;
  } else if (goal === NutritionGoal.GAIN_WEIGHT) {
    if (kcal !== null && kcal >= 300) score += 2.5;
    if (
      slotIds.length === 0 &&
      MAIN_MEALS.includes(section) &&
      kcal !== null &&
      kcal < 160
    ) {
      score -= 2;
    }
    if (pillars.includes(NutritionPillar.PLANT_PROTEIN)) score += 1;
    if (pillars.includes(NutritionPillar.HEALTHY_FAT)) score += 1.5;
  }

  if (dailyTarget !== null && dailyTarget !== undefined && kcal !== null) {
    const nextCalories = dayCalories + kcal;
    if (nextCalories > dailyTarget * CALORIE_CEILING_RATIO) {
      score -= 4;
    } else if (dayCalories < dailyTarget * CALORIE_FLOOR_RATIO) {
      score += Math.min(3, kcal / 150);
    }
  }
  return score;
}

function pillarBalanceScore(
  recipe: GeneratorCandidate,
  dayPillars: ReadonlySet<NutritionPillar>,
): number {
  const pillars = recipe.nutritionPillars ?? [];
  let score = 0;
  for (const pillar of pillars) {
    if (dayPillars.has(pillar)) continue;
    score +=
      pillar === NutritionPillar.PLANT_PROTEIN
        ? PROTEIN_NEEDED_BONUS
        : PILLAR_NEEDED_BONUS;
  }
  return score;
}

function dayNutritionState(
  slots: SlotRecipeIds,
  byId: ReadonlyMap<string, GeneratorCandidate>,
): { dayCalories: number; dayPillars: Set<NutritionPillar> } {
  let dayCalories = 0;
  const dayPillars = new Set<NutritionPillar>();
  for (const id of allIds(slots)) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (typeof candidate.caloriesPerServing === 'number') {
      dayCalories += candidate.caloriesPerServing;
    }
    for (const pillar of candidate.nutritionPillars ?? []) {
      dayPillars.add(pillar);
    }
  }
  return { dayCalories, dayPillars };
}

function fitScore(tag: RecipeTag | null, section: MealSection): number {
  if (tag === null) return 0;
  if (FITS[section].includes(tag)) return FIT_BONUS;
  const isMainMeal = MAIN_MEALS.includes(section);
  if (isMainMeal && NOT_FOR_MAIN_MEALS.includes(tag)) return -MISFIT_PENALTY;
  if (!isMainMeal) return -MISFIT_PENALTY;
  return 0;
}

function emptyDay(): SlotRecipeIds {
  return { BREAKFAST: [], LUNCH: [], DINNER: [], OTHER: [] };
}

function copyDay(day: SlotRecipeIds | undefined): SlotRecipeIds {
  if (!day) return emptyDay();
  return {
    BREAKFAST: [...day.BREAKFAST],
    LUNCH: [...day.LUNCH],
    DINNER: [...day.DINNER],
    OTHER: [...day.OTHER],
  };
}

function allIds(day: SlotRecipeIds): string[] {
  return [...day.BREAKFAST, ...day.LUNCH, ...day.DINNER, ...day.OTHER];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Fills the chosen slots with one dish each. A dish is ranked by how well its
 * tag fits the meal, the user's wishes and liked ingredients, and is pushed
 * down for every time it already appears in the week. The best few are then
 * checked against the dishes already picked for the same meal for incompatible
 * ingredients; other meals of the day do not matter.
 * Returns whole days (all four sections), only for days that changed.
 */
export async function generateMealDays(
  input: GeneratorInput,
): Promise<GeneratedDay[]> {
  const byId = new Map(input.candidates.map((recipe) => [recipe.id, recipe]));
  const week = new Map<Weekday, SlotRecipeIds>();
  const useCount = new Map<string, number>();
  for (const [day, slots] of input.saved) {
    week.set(day, copyDay(slots));
    for (const id of allIds(slots)) {
      useCount.set(id, (useCount.get(id) ?? 0) + 1);
    }
  }

  const changedDays: Weekday[] = [];
  for (const day of input.days) {
    const slots = week.get(day) ?? emptyDay();
    let changed = false;

    const replacedBySection = new Map<MealSection, string[]>();
    for (const section of input.sections) {
      if (
        input.skip.some((slot) => slot.day === day && slot.section === section)
      ) {
        continue;
      }
      if (input.onlyEmpty && slots[section].length > 0) continue;

      const replaced = slots[section];
      replacedBySection.set(section, replaced);
      for (const id of replaced) {
        useCount.set(id, (useCount.get(id) ?? 1) - 1);
      }
      slots[section] = [];
    }

    for (const section of input.sections) {
      const replaced = replacedBySection.get(section);
      if (!replaced) continue;

      const isGainExpandable =
        input.nutritionGoal === NutritionGoal.GAIN_WEIGHT &&
        input.perSection === 1 &&
        (section === MealSection.LUNCH || section === MealSection.DINNER);
      let desiredCount = input.perSection;

      const pickedIds: string[] = [];
      while (pickedIds.length < desiredCount) {
        const sameMeal = idsInMeal(week, section, day);
        for (const id of pickedIds) sameMeal.add(id);
        // Replacing a slot means the user wants something new. Its old dish
        // was just un-counted, so it would otherwise rank as the least used
        // dish and come straight back; keep it only as a last resort.
        for (const id of replaced) sameMeal.add(id);
        const sameDay = new Set(allIds(slots));
        const dayState = dayNutritionState(slots, byId);
        const picked = await pickDish(
          input,
          byId,
          useCount,
          section,
          sameMeal,
          sameDay,
          pickedIds,
          dayState,
        );
        if (picked === null) break;
        pickedIds.push(picked);
        useCount.set(picked, (useCount.get(picked) ?? 0) + 1);
        slots[section] = [...pickedIds];
        if (
          isGainExpandable &&
          pickedIds.length === 1 &&
          (byId.get(picked)?.caloriesPerServing ?? 0) > 0 &&
          (byId.get(picked)?.caloriesPerServing ?? 0) < 420
        ) {
          desiredCount = 2;
        }
      }
      if (pickedIds.length === 0) {
        slots[section] = replaced;
        for (const id of replaced) {
          useCount.set(id, (useCount.get(id) ?? 0) + 1);
        }
        continue;
      }
      slots[section] = pickedIds;
      if (!sameIds(pickedIds, replaced)) changed = true;
    }

    const toppedUp = await topUpDayForCalorieTarget(
      input,
      week,
      day,
      slots,
      byId,
      useCount,
    );
    week.set(day, slots);
    if (changed || toppedUp) changedDays.push(day);
  }

  return changedDays.map((day) => ({ day, ...(week.get(day) ?? emptyDay()) }));
}

async function topUpDayForCalorieTarget(
  input: GeneratorInput,
  week: ReadonlyMap<Weekday, SlotRecipeIds>,
  day: Weekday,
  slots: SlotRecipeIds,
  byId: ReadonlyMap<string, GeneratorCandidate>,
  useCount: Map<string, number>,
): Promise<boolean> {
  const target = input.dailyCalorieTarget;
  if (target === null || target === undefined || target <= 0) return false;
  // Never inflate a partial eating-out day when one of the main meals was left out.
  const allMainPopulated =
    slots.BREAKFAST.length > 0 &&
    slots.LUNCH.length > 0 &&
    slots.DINNER.length > 0;
  if (!allMainPopulated) return false;

  const hasCalorieData = allIds(slots).some(
    (id) => typeof byId.get(id)?.caloriesPerServing === 'number',
  );
  if (!hasCalorieData) return false;

  const calorieFloor = Math.round(target * CALORIE_FLOOR_RATIO);
  const calorieCeiling = Math.round(target * CALORIE_CEILING_RATIO);
  let toppedUp = false;

  for (const { section, maxDishes } of EXPANSION_STEPS) {
    const dayState = dayNutritionState(slots, byId);
    if (dayState.dayCalories >= calorieFloor) break;
    if (!input.sections.includes(section)) continue;
    if (
      input.skip.some((slot) => slot.day === day && slot.section === section)
    ) {
      continue;
    }
    if (slots[section].length >= maxDishes) continue;

    const maxAddedCalories = Math.max(0, calorieCeiling - dayState.dayCalories);
    const sameMeal = idsInMeal(week, section, day);
    for (const id of slots[section]) sameMeal.add(id);
    const sameDay = new Set(allIds(slots));
    const picked = await pickDish(
      input,
      byId,
      useCount,
      section,
      sameMeal,
      sameDay,
      slots[section],
      dayState,
      maxAddedCalories,
    );
    if (picked === null) continue;
    slots[section].push(picked);
    useCount.set(picked, (useCount.get(picked) ?? 0) + 1);
    toppedUp = true;
  }
  return toppedUp;
}

/** Dishes already in this meal (e.g. every breakfast) on the other days. */
function idsInMeal(
  week: ReadonlyMap<Weekday, SlotRecipeIds>,
  section: MealSection,
  exceptDay: Weekday,
): Set<string> {
  const ids = new Set<string>();
  for (const [day, slots] of week) {
    if (day === exceptDay) continue;
    for (const id of slots[section]) ids.add(id);
  }
  return ids;
}

async function pickDish(
  input: GeneratorInput,
  byId: ReadonlyMap<string, GeneratorCandidate>,
  useCount: ReadonlyMap<string, number>,
  section: MealSection,
  sameMeal: ReadonlySet<string>,
  sameDay: ReadonlySet<string>,
  slotIds: readonly string[],
  dayState: { dayCalories: number; dayPillars: Set<NutritionPillar> },
  maxAddedCalories?: number,
): Promise<string | null> {
  const ranked = input.candidates
    .filter((recipe) => {
      if (slotIds.includes(recipe.id)) return false;
      if (
        maxAddedCalories !== undefined &&
        typeof recipe.caloriesPerServing === 'number' &&
        recipe.caloriesPerServing > maxAddedCalories
      ) {
        return false;
      }
      return true;
    })
    .map((recipe) => ({
      recipe,
      score:
        (input.ignoreFit ? 0 : fitScore(recipe.tag, section)) +
        (recipe.matchesQuery ? QUERY_BONUS : 0) +
        recipe.likedCount * LIKED_BONUS +
        nutritionFitScore(
          recipe,
          section,
          input.nutritionGoal,
          dayState.dayCalories,
          input.dailyCalorieTarget,
          slotIds,
          byId,
        ) +
        pillarBalanceScore(recipe, dayState.dayPillars) -
        (useCount.get(recipe.id) ?? 0) * REPEAT_PENALTY -
        (sameDay.has(recipe.id) ? SAME_DAY_REPEAT_PENALTY : 0) -
        (sameMeal.has(recipe.id) ? SAME_MEAL_REPEAT_PENALTY : 0) +
        input.random(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_SIZE);
  if (ranked.length === 0) return null;

  const mealIngredients = new Set<string>();
  for (const id of slotIds) {
    const ingredients =
      input.ingredientsById?.get(id) ?? byId.get(id)?.ingredientIds ?? [];
    for (const ingredientId of ingredients) {
      mealIngredients.add(ingredientId);
    }
  }
  const ingredientSets = ranked.map(({ recipe }) => [
    ...new Set([...mealIngredients, ...recipe.ingredientIds]),
  ]);
  const compatible = await input.areCompatible(ingredientSets);
  const index = compatible.findIndex((ok) => ok);
  if (index === -1) return null;
  return ranked[index].recipe.id;
}
