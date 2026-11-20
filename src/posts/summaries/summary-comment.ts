import type { SummaryIngredient, SummaryRecipe } from '../../mongo/models.js';

interface CommentLabels {
  ingredients: string;
  steps: string;
  servings: string;
  minutes: string;
  disclaimer: string;
  more: string;
}

const VIETNAMESE: CommentLabels = {
  ingredients: 'Nguyên liệu',
  steps: 'Cách làm',
  servings: 'Khẩu phần',
  minutes: 'phút',
  disclaimer:
    'Tóm tắt tự động bởi Vedora AI từ nội dung bài đăng, có thể chưa chính xác.',
  more: '… xem đầy đủ trong bài đăng.',
};

const ENGLISH: CommentLabels = {
  ingredients: 'Ingredients',
  steps: 'Steps',
  servings: 'Servings',
  minutes: 'min',
  disclaimer:
    'Summarized automatically by Vedora AI from this post; it may contain mistakes.',
  more: '… see the post for the rest.',
};

export interface SummaryCommentInput {
  language: string;
  summary: string;
  recipe: SummaryRecipe | null;
}

function labelsFor(language: string): CommentLabels {
  if (language === 'vi') return VIETNAMESE;
  return ENGLISH;
}

function formatQuantity(quantity: number): string {
  if (Number.isInteger(quantity)) return String(quantity);
  return String(Math.round(quantity * 100) / 100);
}

export function formatIngredient(ingredient: SummaryIngredient): string {
  const words: string[] = [];
  if (ingredient.quantity !== null) {
    words.push(formatQuantity(ingredient.quantity));
  }
  if (ingredient.unit) words.push(ingredient.unit);
  words.push(ingredient.name);
  const line = words.join(' ');
  if (!ingredient.note) return `• ${line}`;
  return `• ${line} (${ingredient.note})`;
}

function timingLine(recipe: SummaryRecipe, labels: CommentLabels): string {
  const parts: string[] = [];
  if (recipe.servings !== null) {
    parts.push(`${labels.servings}: ${formatQuantity(recipe.servings)}`);
  }
  const minutes = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
  if (minutes > 0) parts.push(`${minutes} ${labels.minutes}`);
  return parts.join(' · ');
}

function recipeLines(recipe: SummaryRecipe, labels: CommentLabels): string[] {
  const lines: string[] = ['', recipe.title];
  const timing = timingLine(recipe, labels);
  if (timing) lines.push(timing);
  if (recipe.ingredients.length > 0) {
    lines.push('', `${labels.ingredients}:`);
    for (const ingredient of recipe.ingredients) {
      lines.push(formatIngredient(ingredient));
    }
  }
  if (recipe.steps.length > 0) {
    lines.push('', `${labels.steps}:`);
    recipe.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }
  return lines;
}

/**
 * The plain-text comment Vedora AI posts: the summary, then the recipe if
 * any, then a disclaimer. Lines that do not fit `maxLength` are dropped from
 * the end of the recipe, so the summary and the disclaimer always show.
 */
export function formatSummaryComment(
  input: SummaryCommentInput,
  maxLength: number,
): string {
  const labels = labelsFor(input.language);
  const head = input.summary.trim();
  const footer = `\n\n${labels.disclaimer}`;
  const body = input.recipe ? recipeLines(input.recipe, labels) : [];

  let text = head;
  let truncated = false;
  for (const line of body) {
    const next = `${text}\n${line}`;
    if (next.length + footer.length + labels.more.length + 1 > maxLength) {
      truncated = true;
      break;
    }
    text = next;
  }
  if (truncated) text = `${text}\n${labels.more}`;
  const full = `${text}${footer}`;
  if (full.length <= maxLength) return full;
  // Only an overly long summary gets here: cut it, keep the disclaimer.
  const room = maxLength - footer.length - 1;
  return `${head.slice(0, Math.max(room, 0))}…${footer}`;
}
