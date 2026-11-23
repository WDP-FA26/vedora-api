import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
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

const TIMEOUT_MS = runtimeConfig.MEAL_LOG_CALORIE_ESTIMATE_TIMEOUT_MS;
const MAX_OUTPUT_TOKENS = 700;

const INSTRUCTIONS = `Bạn tra cứu năng lượng (kcal) cho một món ăn chay mà người dùng Vedora đã ăn.
Dùng \`webSearch\` để tìm số liệu từ nguồn đáng tin (Viện Dinh dưỡng Quốc gia, USDA FoodData Central, nhãn dinh dưỡng của nhà sản xuất, công thức có phân tích dinh dưỡng). Nếu món có nhiều cách nấu, chọn khẩu phần phổ biến nhất ở Việt Nam và theo mô tả của người dùng.
Đây là ước tính: không bịa số liệu, không bịa nguồn. Nếu không tìm được gì đủ tin cậy, trả caloriesPerServing là null.
Chỉ trả về DUY NHẤT một khối JSON, không thêm chữ ngoài JSON:
\`\`\`json
{
  "caloriesPerServing": 450,
  "note": "1–2 câu tiếng Việt: khẩu phần được giả định và cách ước tính",
  "references": [{ "title": "Tên nguồn", "url": "https://..." }]
}
\`\`\``;

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
    lines.push('Ước tính kcal cho MỘT khẩu phần.');

    const result = await generateText({
      model: this.model,
      system: INSTRUCTIONS,
      prompt: lines.join('\n'),
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
