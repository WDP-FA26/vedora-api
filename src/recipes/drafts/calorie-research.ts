import { tool } from 'ai';
import { z } from 'zod';
import type { PostSourcePart } from '../../posts/summaries/post-source.js';
import {
  type DraftRecipeOutput,
  type DraftSourceLink,
  normalizeSources,
  stripDraftTags,
} from './recipe-draft.js';

/** How much of the source the calorie check sees: enough to name the dish. */
const SOURCE_EXCERPT_CHARS = 1500;
/** Servings assumed when the recipe states none, as the draft prompt does. */
const DEFAULT_SERVINGS = 2;

const calorieAnswerSchema = z.object({
  caloriesPerServing: z
    .number()
    .min(10)
    .max(3000)
    .nullable()
    .describe('Số kcal cho một suất, hoặc null khi không tính được.'),
  calorieNote: z
    .string()
    .nullable()
    .describe(
      '1–3 câu tiếng Việt: cách tính từ nguyên liệu và khẩu phần, và câu trả lời cho Admin nếu có.',
    ),
  sources: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .describe('Các nguồn đã dùng, với URL lấy từ kết quả tìm kiếm.'),
});

export type CalorieAnswer = z.infer<typeof calorieAnswerSchema>;

/**
 * The model answers by calling this tool: its input is checked against the
 * schema, which `Output.object` cannot do here because OpenRouter ignores
 * `response_format` on calls with the web search server tool.
 */
export const submitCalories = tool({
  description:
    'Nộp kết quả kiểm tra kcal. Gọi đúng một lần, sau khi đã tìm kiếm xong.',
  inputSchema: calorieAnswerSchema,
});

/** What a successful web check changes on the draft. */
export interface CalorieResearch {
  caloriesPerServing?: number;
  calorieNote?: string;
  calorieSources: DraftSourceLink[];
}

/** The start of the source, so the check knows which dish the post means. */
export function sourceExcerpt(parts: readonly PostSourcePart[]): string {
  const sections: string[] = [];
  for (const part of parts) {
    sections.push(`## ${part.label}\n${stripDraftTags(part.text)}`);
  }
  return sections.join('\n').slice(0, SOURCE_EXCERPT_CHARS);
}

/** `300 g đậu hũ, 2 quả cà chua, muối`. */
function ingredientList(recipe: DraftRecipeOutput): string {
  const entries: string[] = [];
  for (const item of recipe.ingredients) {
    const pieces: string[] = [];
    if (item.quantity !== null) pieces.push(String(item.quantity));
    if (item.unit) pieces.push(item.unit);
    pieces.push(item.name);
    entries.push(pieces.join(' '));
  }
  return entries.join(', ');
}

/**
 * The user message of the calorie check. The admin's request goes in whole,
 * in its own tag, so a long source or form never cuts it off.
 */
export function calorieResearchPrompt({
  recipe,
  sourceContext,
  instruction,
  today,
}: {
  recipe: DraftRecipeOutput;
  sourceContext: string;
  instruction: string | null;
  today: string;
}): string {
  const servings =
    recipe.servings !== null && recipe.servings >= 1
      ? recipe.servings
      : DEFAULT_SERVINGS;
  const ingredients = ingredientList(recipe) || 'không rõ định lượng';
  const estimate = recipe.caloriesPerServing ?? 'chưa có';
  const lines = [
    `Hôm nay là ${today}.`,
    `Tên món: ${recipe.title}`,
    `Số khẩu phần: ${servings}`,
    `Nguyên liệu: ${ingredients}`,
    `Ước tính sơ bộ hiện có: ${estimate} kcal/suất`,
  ];
  if (sourceContext) {
    lines.push(`<source>\n${sourceContext}\n</source>`);
  }
  if (instruction) {
    const request = stripDraftTags(instruction);
    lines.push(`<admin_request>\n${request}\n</admin_request>`);
  }
  return lines.join('\n');
}

/**
 * Reads the check's result: the submitted answer plus the pages web search
 * cited. Null when it produced nothing the admin could use.
 */
export function calorieResearchOutcome(
  citedSources: readonly DraftSourceLink[],
  answer: CalorieAnswer | undefined,
): CalorieResearch | null {
  const calorieSources = normalizeSources([
    ...citedSources,
    ...(answer?.sources ?? []),
  ]);
  let caloriesPerServing: number | undefined;
  if (typeof answer?.caloriesPerServing === 'number') {
    caloriesPerServing = Math.round(answer.caloriesPerServing);
  }
  const calorieNote = answer?.calorieNote?.trim() || undefined;

  const foundNothing =
    caloriesPerServing === undefined &&
    calorieNote === undefined &&
    calorieSources.length === 0;
  if (foundNothing) return null;
  return { caloriesPerServing, calorieNote, calorieSources };
}

/** The draft with the checked figures; the draft's own values fill any gap. */
export function applyCalorieResearch(
  recipe: DraftRecipeOutput,
  research: CalorieResearch,
): DraftRecipeOutput {
  return {
    ...recipe,
    caloriesPerServing:
      research.caloriesPerServing ?? recipe.caloriesPerServing,
    calorieNote: research.calorieNote ?? recipe.calorieNote,
    calorieSources: research.calorieSources,
  };
}
