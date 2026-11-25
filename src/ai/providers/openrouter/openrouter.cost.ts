import type { ConfigService } from '@nestjs/config';
import type { GenerationResponseData } from '@openrouter/sdk/models';
import { runtimeConfig } from '../../../config/runtime-config.js';
import {
  CostObservation,
  costValue,
  metadataText,
  metricCount,
} from '../../telemetry/cost-observation.js';
import type {
  GenerationFallback,
  ProviderCostAdapter,
} from '../ai-provider.interface.js';
import {
  asObject,
  lookupUnavailable,
  mismatchedGeneration,
} from '../provider-shared.js';
import { createOpenRouterClient } from './openrouter.client.js';

/** Parses OpenRouter JSON / SSE payloads (Chat Completions, Responses API, SDK). */
export function parseOpenRouterPayload(
  payload: unknown,
  observation: CostObservation,
): void {
  const root = asObject(payload);
  const response = asObject(root.response);
  const data = Object.keys(response).length ? response : root;
  const usage = asObject(data.usage);
  observation.generationId =
    metadataText(data.id) ?? observation.generationId;
  observation.resolvedModel =
    metadataText(data.model) ?? observation.resolvedModel;
  observation.provider =
    metadataText(data.provider) ?? observation.provider;
  observation.costUsd = costValue(usage.cost) ?? observation.costUsd;
  observation.inputTokens =
    metricCount(usage.prompt_tokens ?? usage.input_tokens) ??
    observation.inputTokens;
  observation.outputTokens =
    metricCount(usage.completion_tokens ?? usage.output_tokens) ??
    observation.outputTokens;
  observation.reasoningTokens =
    metricCount(
      asObject(usage.completion_tokens_details ?? usage.output_tokens_details)
        .reasoning_tokens,
    ) ?? observation.reasoningTokens;
  const promptDetails = asObject(
    usage.prompt_tokens_details ?? usage.input_tokens_details,
  );
  observation.cachedTokens =
    metricCount(promptDetails.cached_tokens) ?? observation.cachedTokens;
  observation.cacheWriteTokens =
    metricCount(promptDetails.cache_write_tokens) ??
    observation.cacheWriteTokens;
  if (
    root.error ||
    data.error ||
    root.type === 'error' ||
    root.type === 'response.failed'
  ) {
    observation.failed = true;
  }
}

/** Looks up a single generation's settled charge from OpenRouter. */
export async function lookupOpenRouterGeneration(
  config: ConfigService,
  generationId: string,
  fallback: GenerationFallback,
): Promise<CostObservation> {
  // No cost transport fetch here: the lookup itself must not create a cost row.
  const openrouter = createOpenRouterClient(
    config.getOrThrow<string>('OPENROUTER_API_KEY'),
  );
  let data: GenerationResponseData;
  try {
    ({ data } = await openrouter.generations.getGeneration(
      { id: generationId },
      {
        signal: AbortSignal.timeout(runtimeConfig.AI_COST_RECONCILE_TIMEOUT_MS),
      },
    ));
  } catch {
    throw lookupUnavailable();
  }
  if (data.id !== generationId) throw mismatchedGeneration();
  const observation = new CostObservation();
  observation.generationId = generationId;
  observation.resolvedModel = metadataText(
    data.model ?? fallback.resolvedModel,
  );
  observation.provider = metadataText(data.providerName ?? fallback.provider);
  observation.costUsd = costValue(data.totalCost);
  observation.inputTokens = metricCount(data.nativeTokensPrompt);
  observation.outputTokens = metricCount(data.nativeTokensCompletion);
  observation.reasoningTokens = metricCount(data.nativeTokensReasoning);
  observation.cachedTokens = metricCount(
    data.nativeTokensCached ?? fallback.cachedTokens,
  );
  observation.cacheWriteTokens = metricCount(fallback.cacheWriteTokens);
  return observation;
}

export const openRouterCostAdapter: ProviderCostAdapter = {
  baseUrl: runtimeConfig.OPENROUTER_API_BASE_URL,
  parsePayload: parseOpenRouterPayload,
  lookupGeneration: lookupOpenRouterGeneration,
};
