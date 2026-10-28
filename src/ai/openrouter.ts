import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ImageModel, LanguageModel } from 'ai';
import type { ReasoningEffort } from './reasoning.js';

/** Used when the deployment does not pin a chat model. */
export const DEFAULT_CHAT_MODEL = 'openrouter/auto';
export const DEFAULT_MODERATION_MODEL = 'openai/gpt-oss-safeguard-20b';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

/**
 * One place that builds OpenRouter models, so features never construct the
 * provider themselves. Reasoning is excluded from the stream: Vedora renders
 * only the answer.
 */
export function chatModel({
  apiKey,
  modelId,
  reasoningEffort = 'low',
}: {
  apiKey: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}): LanguageModel {
  return createOpenRouter({ apiKey })(modelId, {
    reasoning: { effort: reasoningEffort, exclude: true },
  });
}

export function imageModel({
  apiKey,
  modelId,
}: {
  apiKey: string;
  modelId: string;
}): ImageModel {
  return createOpenRouter({ apiKey }).imageModel(modelId);
}
