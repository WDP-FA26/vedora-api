import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { OpenRouterCacheControl } from '../../ai/openrouter.js';
import { extractJsonObject } from '../../ai/json-text.js';
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
/** Room for low-effort reasoning plus the JSON answer: 700 cut the JSON off. */
const MAX_OUTPUT_TOKENS = 5000;

const estimateOutput = z.object({
  caloriesPerServing: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  references: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .optional(),
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

/** Deduplicated http(s) links, as many as a log entry may keep. */
function usableReferences(
  references: { title: string; url: string }[],
): { title: string; url: string }[] {
  return normalizeSources(references).slice(0, MEAL_LOG_MAX_REFERENCES);
}

/** Looks up a dish's calories per serving on the web. */
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
      ...OpenRouterCacheControl.singleTurn({
        session: 'vedora-calorie-estimator',
        instructions: CALORIE_ESTIMATE_INSTRUCTIONS,
      }),
      prompt: `Hôm nay là ${new Date().toISOString().slice(0, 10)}.\n<dish>\n${lines.join('\n')}\n</dish>`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: { webSearch: webSearchTool() },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const citations: { title: string; url: string }[] = [];
    for (const source of result.sources) {
      if (source.sourceType !== 'url') continue;
      citations.push({ title: source.title ?? '', url: source.url });
    }
    const parsed = estimateOutput.safeParse(extractJsonObject(result.text));
    if (!parsed.success) {
      return {
        caloriesPerServing: null,
        note: null,
        references: usableReferences(citations),
      };
    }
    const note = parsed.data.note?.trim().slice(0, MEAL_LOG_MAX_NOTE_LENGTH);
    return {
      caloriesPerServing: usableCalories(parsed.data.caloriesPerServing),
      note: note || null,
      references: usableReferences([
        ...citations,
        ...(parsed.data.references ?? []),
      ]),
    };
  }
}
