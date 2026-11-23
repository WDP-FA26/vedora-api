import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { loadTextConfig } from '../../config/config-files.js';
import { DEFAULT_CHAT_MODEL } from '../../ai/openrouter.js';
import { extractJsonObject } from '../../ai/json-text.js';
import { webSearchTool } from '../../ai/tools/web-search.tool.js';
import type { PostSourcePart } from '../../posts/summaries/post-source.js';
import {
  type DraftCatalog,
  type DraftOutput,
  type DraftSourceLink,
  describeCatalog,
  draftOutput,
  normalizeSources,
} from './recipe-draft.js';

const INSTRUCTIONS = loadTextConfig(runtimeConfig.RECIPE_DRAFT_PROMPT_FILE);
const TIMEOUT_MS = runtimeConfig.RECIPE_DRAFT_TIMEOUT_MS;
const WEB_RESEARCH_TIMEOUT_MS =
  runtimeConfig.RECIPE_DRAFT_WEB_RESEARCH_TIMEOUT_MS;

const calorieResearchSchema = z.object({
  caloriesPerServing: z.number().min(10).max(3000).nullable().optional(),
  calorieNote: z.string().nullable().optional(),
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
});

/** Asks the chat model for a recipe draft of a source, matched to the catalog, then verifies calories on the web. */
@Injectable()
export class RecipeDraftGenerator {
  readonly modelId: string;
  private readonly logger = new Logger(RecipeDraftGenerator.name);

  constructor(
    private readonly ai: AiService,
    config: ConfigService,
    @Optional() @InjectModel() private readonly model?: LanguageModel,
  ) {
    this.modelId = config.get<string>('OPENROUTER_MODEL', DEFAULT_CHAT_MODEL);
  }

  async generate(
    parts: PostSourcePart[],
    catalog: DraftCatalog,
  ): Promise<DraftOutput> {
    const sections: string[] = [];
    for (const part of parts) {
      sections.push(`## ${part.label}\n${part.text}`);
    }
    const { object } = await this.ai.generateObject({
      label: 'draft-recipe',
      instructions: INSTRUCTIONS,
      prompt: [
        `<catalog>\n${describeCatalog(catalog)}\n</catalog>`,
        `<source>\n${sections.join('\n\n')}\n</source>`,
      ].join('\n\n'),
      schema: draftOutput,
      schemaName: 'recipe_draft',
      timeout: TIMEOUT_MS,
    });

    if (!object.recipe || !this.model) return object;

    const researched = await this.researchCaloriesFromWeb(
      this.model,
      object.recipe,
      sections,
    );
    if (!researched) return object;

    return {
      recipe: {
        ...object.recipe,
        ...(researched.caloriesPerServing !== undefined
          ? { caloriesPerServing: researched.caloriesPerServing }
          : {}),
        ...(researched.calorieNote !== undefined
          ? { calorieNote: researched.calorieNote }
          : {}),
        calorieSources: researched.calorieSources,
      },
    };
  }

  private async researchCaloriesFromWeb(
    model: LanguageModel,
    recipe: NonNullable<DraftOutput['recipe']>,
    sourceSections: readonly string[],
  ): Promise<{
    caloriesPerServing?: number;
    calorieNote?: string;
    calorieSources: DraftSourceLink[];
  } | null> {
    const servings =
      recipe.servings && recipe.servings >= 1 ? recipe.servings : 2;
    const ingredientLines = recipe.ingredients
      .map((item) => {
        const amount = [item.quantity, item.unit]
          .filter((part) => part !== null && part !== '')
          .join(' ');
        return amount ? `${amount} ${item.name}` : item.name;
      })
      .join(', ');
    const sourceContext = sourceSections.join('\n').slice(0, 1500);

    try {
      const result = await generateText({
        model,
        maxOutputTokens: 700,
        tools: { webSearch: webSearchTool() },
        abortSignal: AbortSignal.timeout(WEB_RESEARCH_TIMEOUT_MS),
        system: `Bạn là Trợ lý AI hỗ trợ Admin món ăn của Vedora. Hãy dùng \`webSearch\` tra cứu giá trị dinh dưỡng / calo thực tế (USDA, Viện Dinh dưỡng, hoặc nguồn uy tín) cho món ăn chay và từng nguyên liệu chính bên dưới, tính tổng kcal và chia cho ${servings} khẩu phần để ước tính kcal/1 suất. Nếu Admin có yêu cầu/câu hỏi riêng trong ngữ cảnh, hãy trả lời ngắn gọn, rõ ràng trong \`calorieNote\`.
Sau khi tra web, chỉ trả về DUY NHẤT một khối JSON theo mẫu (không thêm chữ ngoài JSON):
\`\`\`json
{
  "caloriesPerServing": 320,
  "calorieNote": "Tóm tắt ngắn gọn bằng tiếng Việt (1-3 câu) cách tính kcal từ các nguyên liệu chính / khẩu phần và trả lời câu hỏi của Admin nếu có.",
  "sources": [
    { "title": "Tên nguồn tham khảo", "url": "https://..." }
  ]
}
\`\`\``,
        prompt: [
          `Tên món: ${recipe.title}`,
          `Số khẩu phần: ${servings}`,
          `Nguyên liệu: ${ingredientLines || 'không rõ định lượng'}`,
          `Ước tính sơ bộ hiện có: ${recipe.caloriesPerServing ?? 'chưa có'} kcal/suất`,
          sourceContext
            ? `Ngữ cảnh từ Admin / bài viết:\n${sourceContext}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });

      const webCitationSources: DraftSourceLink[] = [];
      for (const source of result.sources) {
        if (source.sourceType !== 'url') continue;
        webCitationSources.push({
          title: source.title ?? '',
          url: source.url,
        });
      }

      const parsed = calorieResearchSchema.safeParse(
        extractJsonObject(result.text),
      );
      const parsedSources = parsed.success ? (parsed.data.sources ?? []) : [];
      const calorieSources = normalizeSources([
        ...webCitationSources,
        ...parsedSources,
      ]);

      const caloriesPerServing =
        parsed.success &&
        typeof parsed.data.caloriesPerServing === 'number' &&
        Number.isFinite(parsed.data.caloriesPerServing)
          ? Math.round(parsed.data.caloriesPerServing)
          : undefined;
      const calorieNote =
        parsed.success && parsed.data.calorieNote?.trim()
          ? parsed.data.calorieNote.trim()
          : undefined;

      if (
        caloriesPerServing === undefined &&
        calorieNote === undefined &&
        calorieSources.length === 0
      ) {
        return null;
      }

      return {
        ...(caloriesPerServing !== undefined ? { caloriesPerServing } : {}),
        ...(calorieNote !== undefined ? { calorieNote } : {}),
        calorieSources,
      };
    } catch (error) {
      this.logger.warn(
        `Recipe calorie web research failed cleanly, keeping initial estimate: ${String(error)}`,
      );
      return null;
    }
  }
}
