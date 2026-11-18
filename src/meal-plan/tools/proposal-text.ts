import type {
  MealPlanPreviewDto,
  MealPlanProblemDto,
} from '../dto/meal-plan.dto.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';

/** What `fillSlots` and `editDraft` return, and what the app shows as a proposal card. */
export type DraftProposal = MealPlanPreviewDto & { ok: boolean };

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

const titles = (recipes: { title: string; id: string }[]) =>
  recipes.map(({ title, id }) => `${title} (id ${id})`).join(', ');

/** The slots of the draft that differ from the saved plan, one line per day. */
export function describeDraft(proposal: DraftProposal): string {
  const lines: string[] = [];
  for (const { day, sections } of proposal.days) {
    const parts: string[] = [];
    for (const { section, recipes, previous } of sections) {
      const same =
        recipes.map(({ id }) => id).join() ===
        previous.map(({ id }) => id).join();
      if (same) continue;
      const now = recipes.length > 0 ? titles(recipes) : '(empty)';
      parts.push(`${SECTION_NAMES[section]}: ${now}`);
    }
    if (parts.length > 0)
      lines.push(`- ${DAY_NAMES[day]}: ${parts.join('; ')}`);
  }
  return lines.join('\n');
}

export function proposalFeedback(
  proposal: DraftProposal,
  errors: string[] = [],
): string {
  const notes =
    errors.length > 0
      ? `\nNot applied:\n${errors.map((error) => `- ${error}`).join('\n')}`
      : '';
  if (proposal.problems.length > 0) {
    const draft = describeDraft(proposal);
    const header =
      draft === ''
        ? 'Nothing was kept. Fix these and call again:'
        : 'Not shown to user yet. Fix these and call again:';
    const context = draft !== '' ? `\nCurrent unsaved draft:\n${draft}` : '';
    return `${header}\n${proposal.problems.map(describeProblem).join('\n')}${context}${notes}`;
  }
  if (proposal.days.length === 0) {
    return `The draft has no changes from the saved plan.${notes}`;
  }
  return `The draft is on screen, not saved. The user presses "Áp dụng" to keep it. Unsaved changes so far:\n${describeDraft(proposal)}${notes}`;
}
