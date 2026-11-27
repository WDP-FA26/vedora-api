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
  submitCalories,
} from './calorie-research.js';
import {
  type DraftCatalog,
  type DraftOutput,
  type DraftRecipeOutput,
  type DraftRequest,
  type DraftSourceLink,
  draftOutput,
} from './recipe-draft.js';
import {
  buildCalorieResearchPrompt,
  buildRecipeDraftCatalogPrompt,
  buildRecipeDraftPrompt,
  CALORIE_RESEARCH_INSTRUCTIONS,
  RECIPE_DRAFT_INSTRUCTIONS,
} from './recipe-draft.prompt.js';

const TIMEOUT_MS = runtimeConfig.RECIPE_DRAFT_TIMEOUT_MS;
const WEB_RESEARCH_TIMEOUT_MS =
  runtimeConfig.RECIPE_DRAFT_WEB_RESEARCH_TIMEOUT_MS;
const WEB_RESEARCH_MAX_OUTPUT_TOKENS =
  runtimeConfig.RECIPE_DRAFT_WEB_RESEARCH_MAX_OUTPUT_TOKENS;

export interface DraftResult {
  output: DraftOutput;
  calorieResearch: CalorieResearchStatus;
}

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
        buildRecipeDraftCatalogPrompt(catalog),
        buildRecipeDraftPrompt(request),
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

  private async researchCaloriesOnWeb(
    recipe: DraftRecipeOutput,
    request: DraftRequest,
  ): Promise<CalorieResearch | null> {
    const prompt = buildCalorieResearchPrompt({
      recipe,
      parts: request.parts,
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
        effort: 'medium',
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
