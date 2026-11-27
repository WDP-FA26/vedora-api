import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel } from 'ai';
import { DEFAULT_CHAT_MODEL } from '../../ai/models.js';
import { PromptCache } from '../../ai/prompt-cache.js';
import { webSearchTool } from '../../ai/tools/web-search.tool.js';
import type { CalorieResearchStatus } from '../dto/recipe-draft.dto.js';
import {
  applyCalorieResearch,
  type CalorieResearch,
  calorieResearchOutcome,
  calorieResearchPrompt,
  sourceExcerpt,
  submitCalories,
} from './calorie-research.js';
import {
  type DraftCatalog,
  type DraftOutput,
  type DraftRecipeOutput,
  type DraftRequest,
  type DraftSourceLink,
  describeCatalog,
  draftOutput,
  draftRequestText,
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

export interface DraftResult {
  output: DraftOutput;
  calorieResearch: CalorieResearchStatus;
}

/**
 * Asks the chat model for a recipe draft matched to the catalog, then, when
 * the model says the kcal need checking, verifies them on the web.
 */
@Injectable()
export class RecipeDraftGenerator {
  readonly modelId: string;
  private readonly logger = new Logger(RecipeDraftGenerator.name);

  constructor(
    private readonly ai: AiService,
    config: ConfigService,
    @InjectModel() private readonly model: LanguageModel,
  ) {
    this.modelId = config.get<string>('AI_CHAT_MODEL', DEFAULT_CHAT_MODEL);
  }

  async generate(
    request: DraftRequest,
    catalog: DraftCatalog,
  ): Promise<DraftResult> {
    const { object } = await this.ai.generateObject({
      label: 'draft-recipe',
      instructions: RECIPE_DRAFT_INSTRUCTIONS,
      messages: PromptCache.prefixMessages(
        `<catalog>\n${describeCatalog(catalog)}\n</catalog>`,
        draftRequestText(request),
        // Admins draft now and then, not all day: a 1h write (2x input) would
        // rarely be read again, a 5m one (1.25x) covers a drafting session.
        '5m',
      ),
      providerOptions: PromptCache.sticky('vedora-recipe-draft'),
      schema: draftOutput,
      schemaName: 'recipe_draft',
      timeout: TIMEOUT_MS,
    });

    const { recipe } = object;
    if (!recipe || !object.researchCalories) {
      return { output: object, calorieResearch: 'SKIPPED' };
    }
    const research = await this.researchCaloriesOnWeb(recipe, request);
    if (!research) {
      return { output: object, calorieResearch: 'FAILED' };
    }
    return {
      output: { ...object, recipe: applyCalorieResearch(recipe, research) },
      calorieResearch: 'DONE',
    };
  }

  /**
   * Null when the check failed or found nothing. The draft is still worth
   * returning then, so the caller reports `FAILED` instead of failing the
   * whole request.
   */
  private async researchCaloriesOnWeb(
    recipe: DraftRecipeOutput,
    request: DraftRequest,
  ): Promise<CalorieResearch | null> {
    const prompt = calorieResearchPrompt({
      recipe,
      sourceContext: sourceExcerpt(request.parts),
      instruction: request.instruction,
      today: new Date().toISOString().slice(0, 10),
    });

    try {
      return await this.runCalorieResearch(prompt);
    } catch (error: unknown) {
      this.logger.warn(
        `Recipe calorie web research failed, reporting FAILED: ${String(error)}`,
      );
      return null;
    }
  }

  private async runCalorieResearch(
    prompt: string,
  ): Promise<CalorieResearch | null> {
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
      prompt,
    });

    const cited: DraftSourceLink[] = [];
    for (const source of result.sources) {
      if (source.sourceType !== 'url') continue;
      cited.push({ title: source.title ?? '', url: source.url });
    }
    const answer = result.staticToolCalls.find(
      (call) => call.toolName === 'submitCalories',
    )?.input;
    return calorieResearchOutcome(cited, answer);
  }
}
