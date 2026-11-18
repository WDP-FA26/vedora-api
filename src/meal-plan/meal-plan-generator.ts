import { MealSection, RecipeTag, Weekday } from '../mongo/models.js';

/** A recipe the user may eat, reduced to what the generator ranks on. */
export interface GeneratorCandidate {
  id: string;
  title: string;
  tag: RecipeTag | null;
  minutes: number | null;
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
const REPEAT_PENALTY = 2;
const FIT_BONUS = 4;
const MISFIT_PENALTY = 6;
const QUERY_BONUS = 5;
const LIKED_BONUS = 1.5;
const SHORTLIST_SIZE = 8;

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

      const pickedIds: string[] = [];
      while (pickedIds.length < input.perSection) {
        const sameMeal = idsInMeal(week, section, day);
        for (const id of pickedIds) sameMeal.add(id);
        // Replacing a slot means the user wants something new. Its old dish
        // was just un-counted, so it would otherwise rank as the least used
        // dish and come straight back; keep it only as a last resort.
        for (const id of replaced) sameMeal.add(id);
        const picked = await pickDish(
          input,
          byId,
          useCount,
          section,
          sameMeal,
          pickedIds,
        );
        if (picked === null) break;
        pickedIds.push(picked);
        useCount.set(picked, (useCount.get(picked) ?? 0) + 1);
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

    week.set(day, slots);
    if (changed) changedDays.push(day);
  }

  return changedDays.map((day) => ({ day, ...(week.get(day) ?? emptyDay()) }));
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
  slotIds: readonly string[],
): Promise<string | null> {
  const ranked = input.candidates
    .filter((recipe) => !slotIds.includes(recipe.id))
    .map((recipe) => ({
      recipe,
      score:
        (input.ignoreFit ? 0 : fitScore(recipe.tag, section)) +
        (recipe.matchesQuery ? QUERY_BONUS : 0) +
        recipe.likedCount * LIKED_BONUS -
        (useCount.get(recipe.id) ?? 0) * REPEAT_PENALTY -
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
