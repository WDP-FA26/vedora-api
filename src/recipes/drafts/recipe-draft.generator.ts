import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel, tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_CHAT_MODEL } from '../../ai/openrouter.js';
import { PromptCache } from '../../ai/prompt-cache.js';
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
import {
  CALORIE_RESEARCH_INSTRUCTIONS,
  RECIPE_DRAFT_INSTRUCTIONS,
} from './recipe-draft.prompt.js';

const TIMEOUT_MS = runtimeConfig.RECIPE_DRAFT_TIMEOUT_MS;
const WEB_RESEARCH_TIMEOUT_MS =
  runtimeConfig.RECIPE_DRAFT_WEB_RESEARCH_TIMEOUT_MS;
/** Room for medium-effort reasoning plus the JSON answer: 700 cut the JSON off. */
const WEB_RESEARCH_MAX_OUTPUT_TOKENS =
  runtimeConfig.RECIPE_DRAFT_WEB_RESEARCH_MAX_OUTPUT_TOKENS;

const calorieResearchSchema = z.object({
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

/**
 * The model answers by calling this tool: its input is checked against the
 * schema, which `Output.object` cannot do here because OpenRouter ignores
 * `response_format` on calls with the web search server tool.
 */
const submitCalories = tool({
  description:
    'Nộp kết quả kiểm tra kcal. Gọi đúng một lần, sau khi đã tìm kiếm xong.',
  inputSchema: calorieResearchSchema,
});

/** Asks the chat model for a recipe draft of a source, matched to the catalog, then verifies calories on the web. */
@Injectable()
export class RecipeDraftGenerator {
  readonly modelId: string;
  private readonly logger = new Logger(RecipeDraftGenerator.name);

  constructor(
    private readonly ai: AiService,
    config: ConfigService,
    @InjectModel() private readonly model: LanguageModel,
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
      instructions: RECIPE_DRAFT_INSTRUCTIONS,
      messages: PromptCache.prefixMessages(
        `<catalog>\n${describeCatalog(catalog)}\n</catalog>`,
        `<source>\n${sections.join('\n\n')}\n</source>`,
      ),
      providerOptions: PromptCache.sticky('vedora-recipe-draft'),
      schema: draftOutput,
      schemaName: 'recipe_draft',
      timeout: TIMEOUT_MS,
    });

    if (!object.recipe) return object;

    const researched = await this.researchCaloriesFromWeb(
      object.recipe,
      sections,
    );
    if (!researched) return object;

    const { recipe } = object;
    return {
      recipe: {
        ...recipe,
        caloriesPerServing:
          researched.caloriesPerServing ?? recipe.caloriesPerServing,
        calorieNote: researched.calorieNote ?? recipe.calorieNote,
        calorieSources: researched.calorieSources,
      },
    };
  }

  private async researchCaloriesFromWeb(
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
        model: this.model,
        maxOutputTokens: WEB_RESEARCH_MAX_OUTPUT_TOKENS,
        tools: { webSearch: webSearchTool(), submitCalories },
        abortSignal: AbortSignal.timeout(WEB_RESEARCH_TIMEOUT_MS),
        ...PromptCache.singleTurn({
          session: 'vedora-recipe-calorie-research',
          instructions: CALORIE_RESEARCH_INSTRUCTIONS,
          // At low effort it more often estimates without searching.
          effort: 'medium',
          // 5m, not 1h: with web search the loop's own cache writes (~20K
          // tokens of results, never read again) take this TTL, and 1h bills
          // them at 2x input instead of 1.25x (~30% more per call, measured).
          ttl: '5m',
        }),
        prompt: [
          `Hôm nay là ${new Date().toISOString().slice(0, 10)}.`,
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

      const answer = result.staticToolCalls.find(
        (call) => call.toolName === 'submitCalories',
      )?.input;
      const calorieSources = normalizeSources([
        ...webCitationSources,
        ...(answer?.sources ?? []),
      ]);

      let caloriesPerServing: number | undefined;
      if (typeof answer?.caloriesPerServing === 'number') {
        caloriesPerServing = Math.round(answer.caloriesPerServing);
      }
      const calorieNote = answer?.calorieNote?.trim() || undefined;

      if (
        caloriesPerServing === undefined &&
        calorieNote === undefined &&
        calorieSources.length === 0
      ) {
        return null;
      }

      return { caloriesPerServing, calorieNote, calorieSources };
    } catch (error) {
      this.logger.warn(
        `Recipe calorie web research failed cleanly, keeping initial estimate: ${String(error)}`,
      );
      return null;
    }
  }
}
