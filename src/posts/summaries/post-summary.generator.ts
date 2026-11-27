import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/ai';
import { generateText, type LanguageModel, Output } from 'ai';
import { z } from 'zod';
import { DEFAULT_CHAT_MODEL } from '../../ai/models.js';
import { PromptCache } from '../../ai/prompt-cache.js';
import { RecipeTag } from '../../mongo/models.js';
import type { PostSourcePart } from './post-source.js';
import {
  buildPostSummaryPrompt,
  POST_SUMMARY_INSTRUCTIONS,
} from './post-summary.prompt.js';

const TIMEOUT_MS = runtimeConfig.POST_SUMMARY_TIMEOUT_MS;

const ingredientOutput = z.object({
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  note: z.string().nullable(),
});

const recipeOutput = z.object({
  title: z.string(),
  description: z.string().nullable(),
  tag: z.enum(RecipeTag).nullable(),
  servings: z.number().nullable(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  ingredients: z.array(ingredientOutput),
  steps: z.array(z.string()),
});

export const summaryOutput = z.object({
  worthSummarizing: z.boolean(),
  language: z.string(),
  summary: z.string(),
  recipe: recipeOutput.nullable(),
});

export type SummaryOutput = z.infer<typeof summaryOutput>;

export type SummarySourcePart = PostSourcePart;

@Injectable()
export class PostSummaryGenerator {
  readonly modelId: string;

  constructor(
    config: ConfigService,
    @InjectModel() private readonly model: LanguageModel,
  ) {
    this.modelId = config.get<string>('AI_CHAT_MODEL', DEFAULT_CHAT_MODEL);
  }

  async generate(parts: SummarySourcePart[]): Promise<SummaryOutput> {
    const prompt = buildPostSummaryPrompt(parts);
    const result = await generateText({
      model: this.model,
      ...PromptCache.singleTurn({
        session: 'vedora-post-summary',
        instructions: POST_SUMMARY_INSTRUCTIONS,
      }),
      prompt,
      output: Output.object({ schema: summaryOutput, name: 'post_summary' }),
      maxRetries: runtimeConfig.AI_DECISION_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return result.output;
  }
}
