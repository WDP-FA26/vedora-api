import { runtimeConfig } from '../../../config/runtime-config.js';
import { loadTextConfig } from '../../../config/config-files.js';
export interface EditorSnapshot {
  title: string;
  content: string;
  selection?: string;
}

export interface LinkedRecipe {
  title: string;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: { name: string; quantity: string | null; unit: string | null }[];
}

const RULES = loadTextConfig(runtimeConfig.BLOG_SYSTEM_PROMPT_FILE);

export function blogAssistantInstructions(
  editor: EditorSnapshot,
  recipes: LinkedRecipe[],
): string {
  const parts = [
    RULES,
    `<title>${escape(editor.title)}</title>`,
    `<draft>\n${escape(editor.content) || '(bản nháp đang trống)'}\n</draft>`,
  ];
  if (editor.selection)
    parts.push(`<selection>\n${escape(editor.selection)}\n</selection>`);
  if (recipes.length)
    parts.push(
      `<recipes>\n${recipes.map(describeRecipe).join('\n')}\n</recipes>`,
    );
  return parts.join('\n\n');
}

function describeRecipe(recipe: LinkedRecipe): string {
  const minutes = [
    recipe.prepMinutes !== null && `sơ chế ${recipe.prepMinutes} phút`,
    recipe.cookMinutes !== null && `nấu ${recipe.cookMinutes} phút`,
  ].filter(Boolean);
  const ingredients = recipe.ingredients
    .map(({ name, quantity, unit }) =>
      [quantity, unit, name].filter(Boolean).join(' '),
    )
    .join(', ');
  return `- ${escape(recipe.title)} (${recipe.servings} người ăn${
    minutes.length ? `, ${minutes.join(', ')}` : ''
  }): ${escape(ingredients)}`;
}

function escape(text: string): string {
  return text.replace(
    /<\/?(title|draft|selection|recipes|document)\b[^>]*>?/gi,
    '',
  );
}
