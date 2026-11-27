import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel, tool } from 'ai';
import { z } from 'zod';
import { PromptCache } from '../../ai/prompt-cache.js';
import { webSearchTool } from '../../ai/tools/web-search.tool.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import { normalizeSources } from '../../recipes/drafts/recipe-draft.js';
import {
  MEAL_LOG_MAX_CALORIES_PER_SERVING,
  MEAL_LOG_MAX_NOTE_LENGTH,
  MEAL_LOG_MAX_REFERENCES,
  type CalorieEstimateDto,
} from '../dto/meal-log.dto.js';
import { CALORIE_ESTIMATE_INSTRUCTIONS } from './calorie-estimator.prompt.js';

const TIMEOUT_MS = runtimeConfig.MEAL_LOG_CALORIE_ESTIMATE_TIMEOUT_MS;
const MAX_OUTPUT_TOKENS =
  runtimeConfig.MEAL_LOG_CALORIE_ESTIMATE_MAX_OUTPUT_TOKENS;

const estimateOutput = z.object({
  caloriesPerServing: z
    .number()
    .nullable()
    .describe(
      'Số kcal cho một khẩu phần, hoặc null khi không có số liệu đủ tin cậy.',
    ),
  note: z
    .string()
    .nullable()
    .describe('1–2 câu tiếng Việt: khẩu phần đã giả định và cách ước tính.'),
  references: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .describe('Các nguồn đã dùng, với URL lấy từ kết quả tìm kiếm.'),
});

const submitEstimate = tool({
  description:
    'Nộp kết quả tra cứu kcal. Gọi đúng một lần, sau khi đã tìm kiếm xong.',
  inputSchema: estimateOutput,
});

export interface CalorieQuestion {
  name: string;
  details?: string;
}

function usableCalories(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > MEAL_LOG_MAX_CALORIES_PER_SERVING) return null;
  return Math.round(value);
}

function usableReferences(
  references: { title: string; url: string }[],
): { title: string; url: string }[] {
  return normalizeSources(references).slice(0, MEAL_LOG_MAX_REFERENCES);
}

@Injectable()
export class CalorieEstimator {
  constructor(@InjectModel() private readonly model: LanguageModel) {}

  async estimate(question: CalorieQuestion): Promise<CalorieEstimateDto> {
    const lines = [`Món: ${question.name}`];
    if (question.details)
      lines.push(`Mô tả của người dùng: ${question.details}`);
    lines.push('Ước tính kcal cho một khẩu phần.');

    const result = await generateText({
      model: this.model,
      ...PromptCache.singleTurn({
        session: 'vedora-calorie-estimator',
        instructions: CALORIE_ESTIMATE_INSTRUCTIONS,
        effort: 'medium',
        ttl: '5m',
      }),
      prompt: `Hôm nay là ${new Date().toISOString().slice(0, 10)}.\n<dish>\n${lines.join('\n')}\n</dish>`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: { webSearch: webSearchTool(), submitEstimate },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const citations: { title: string; url: string }[] = [];
    for (const source of result.sources) {
      if (source.sourceType !== 'url') continue;
      citations.push({ title: source.title ?? '', url: source.url });
    }
    const answer = result.staticToolCalls.find(
      (call) => call.toolName === 'submitEstimate',
    );
    if (!answer) {
      return {
        caloriesPerServing: null,
        note: null,
        references: usableReferences(citations),
      };
    }
    const { caloriesPerServing, note, references } = answer.input;
    const trimmedNote = note?.trim().slice(0, MEAL_LOG_MAX_NOTE_LENGTH);
    return {
      caloriesPerServing: usableCalories(caloriesPerServing),
      note: trimmedNote || null,
      references: usableReferences([...citations, ...references]),
    };
  }
}
