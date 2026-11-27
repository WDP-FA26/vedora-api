import { tool } from 'ai';
import { z } from 'zod';
import {
  type DraftRecipeOutput,
  type DraftSourceLink,
  normalizeSources,
} from './recipe-draft.js';

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

export const submitCalories = tool({
  description:
    'Nộp kết quả kiểm tra kcal. Gọi đúng một lần, sau khi đã tìm kiếm xong.',
  inputSchema: calorieAnswerSchema,
});

export interface CalorieResearch {
  caloriesPerServing?: number;
  calorieNote?: string;
  calorieSources: DraftSourceLink[];
}

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
