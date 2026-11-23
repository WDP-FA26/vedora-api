import type { MealPlanProblemDto } from '../dto/meal-plan.dto.js';
import type { PlanChange } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';

export type { PlanChange };

export function describeProblem(problem: MealPlanProblemDto): string {
  const day = DAY_NAMES[problem.day];
  const recipes = problem.recipes.join(', ');
  switch (problem.code) {
    case 'UNKNOWN_RECIPE':
      return `- ${day}: a recipe id does not exist; use ids from searchRecipes.`;
    case 'AVOIDED_INGREDIENT':
      return `- ${day}: "${recipes}" has ${problem.ingredients.join(', ')}, which the user does not eat.`;
    case 'DAY_CONFLICT':
      return `- ${day}: ${problem.ingredients.join(' and ')} must not be eaten in the same meal (${problem.reason ?? 'incompatible'}); they come from: ${recipes}.`;
  }
}

type DishRef = {
  title: string;
  id: string;
  caloriesPerServing?: number | null;
};

function titles(recipes: readonly DishRef[]): string {
  if (recipes.length === 0) return '(empty)';
  const names: string[] = [];
  for (const { title, id, caloriesPerServing } of recipes) {
    if (typeof caloriesPerServing === 'number') {
      names.push(`${title} (id ${id}, ~${caloriesPerServing} kcal)`);
    } else {
      names.push(`${title} (id ${id})`);
    }
  }
  return names.join(', ');
}

function sameDishes(a: readonly DishRef[], b: readonly DishRef[]): boolean {
  return (
    a.length === b.length && a.every(({ id }, index) => id === b[index].id)
  );
}

/** The slots that changed, one line per day, with the day's new kcal total. */
export function describeChange(change: PlanChange): string {
  const lines: string[] = [];
  for (const { day, sections } of change.days) {
    const parts: string[] = [];
    let dayCalories = 0;
    let hasCalories = false;
    for (const { section, recipes, previous } of sections) {
      for (const recipe of recipes) {
        if (typeof recipe.caloriesPerServing !== 'number') continue;
        dayCalories += recipe.caloriesPerServing;
        hasCalories = true;
      }
      if (sameDishes(recipes, previous)) continue;
      parts.push(`${SECTION_NAMES[section]}: ${titles(recipes)}`);
    }
    if (parts.length === 0) continue;
    const totalNote = hasCalories ? ` [tổng ngày ~${dayCalories} kcal]` : '';
    lines.push(`- ${DAY_NAMES[day]}: ${parts.join('; ')}${totalNote}`);
  }
  return lines.join('\n');
}

/** What the model reads after a tool wrote (or failed to write) the plan. */
export function changeFeedback(
  change: PlanChange,
  errors: readonly string[] = [],
): string {
  const notes =
    errors.length > 0
      ? `\nNot applied:\n${errors.map((error) => `- ${error}`).join('\n')}`
      : '';
  if (!change.applied && change.problems.length > 0) {
    return `Nothing was saved. Fix these and call again:\n${change.problems.map(describeProblem).join('\n')}${notes}`;
  }
  if (!change.applied) {
    return `No slot changed.${notes}`;
  }
  const clashes = change.problems.filter(({ code }) => code === 'DAY_CONFLICT');
  const clashNote =
    clashes.length > 0
      ? `\nSaved with same-day clash warnings (fix them unless the user wants them):\n${clashes.map(describeProblem).join('\n')}`
      : '';
  return `Saved to the user's plan for the week of ${change.weekStart}; the app shows the change in the chat and the user can rewind it. Changes:\n${describeChange(change)}${clashNote}${notes}`;
}

/**
 * Two changes saved one after the other as one: each day keeps the dishes
 * from before `first` and the dishes after `second`, so a rewind goes back
 * past both.
 */
export function mergeChanges(
  first: PlanChange,
  second: PlanChange,
): PlanChange {
  if (!first.applied) return second;
  if (!second.applied) return first;
  const days = [...first.days];
  for (const later of second.days) {
    const index = days.findIndex(({ day }) => day === later.day);
    if (index < 0) {
      days.push(later);
      continue;
    }
    const earlier = days[index];
    const sections = later.sections.map((section) => {
      const before = earlier.sections.find(
        (item) => item.section === section.section,
      );
      return { ...section, previous: before?.previous ?? section.previous };
    });
    days[index] = { ...later, sections };
  }
  return {
    weekStart: second.weekStart,
    days,
    problems: second.problems,
    applied: true,
  };
}
