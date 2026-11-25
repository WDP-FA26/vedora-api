import type { ConfigService } from '@nestjs/config';
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
import { createGatewayClient } from './gateway.client.js';

/**
 * Parses AI Gateway HTTP JSON / SSE parts: cost, generation id and route live
 * in `providerMetadata.gateway`; token counts use the AI SDK's usage shape.
 */
export function parseGatewayPayload(
  payload: unknown,
  observation: CostObservation,
): void {
  const root = asObject(payload);
  if (root.type === 'error' || root.error) observation.failed = true;
  const gateway = asObject(asObject(root.providerMetadata).gateway);
  const routing = asObject(gateway.routing);
  observation.generationId =
    metadataText(gateway.generationId) ?? observation.generationId;
  observation.resolvedModel =
    metadataText(routing.canonicalSlug) ?? observation.resolvedModel;
  observation.provider =
    metadataText(routing.finalProvider) ?? observation.provider;
  observation.costUsd = costValue(gateway.cost) ?? observation.costUsd;
  const usage = asObject(root.usage);
  const input = asObject(usage.inputTokens);
  const output = asObject(usage.outputTokens);
  observation.inputTokens =
    metricCount(input.total ?? usage.tokens) ?? observation.inputTokens;
  observation.outputTokens =
    metricCount(output.total) ?? observation.outputTokens;
  observation.reasoningTokens =
    metricCount(output.reasoning) ?? observation.reasoningTokens;
  observation.cachedTokens =
    metricCount(input.cacheRead) ?? observation.cachedTokens;
  observation.cacheWriteTokens =
    metricCount(input.cacheWrite) ?? observation.cacheWriteTokens;
}

function fetchWithTimeout(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
}

/** Looks up a single generation's settled charge from Vercel AI Gateway. */
export async function lookupGatewayGeneration(
  config: ConfigService,
  generationId: string,
  fallback: GenerationFallback,
): Promise<CostObservation> {
  // No cost transport fetch here: the lookup itself must not create a cost row.
  const gateway = createGatewayClient(
    config.getOrThrow<string>('AI_GATEWAY_API_KEY'),
    fetchWithTimeout(runtimeConfig.AI_COST_RECONCILE_TIMEOUT_MS),
  );
  let data: Awaited<ReturnType<typeof gateway.getGenerationInfo>>;
  try {
    data = await gateway.getGenerationInfo({ id: generationId });
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
  observation.inputTokens = metricCount(data.promptTokens);
  observation.outputTokens = metricCount(data.completionTokens);
  observation.reasoningTokens = metricCount(data.reasoningTokens);
  observation.cachedTokens = metricCount(data.cachedTokens);
  observation.cacheWriteTokens = metricCount(data.cacheCreationTokens);
  return observation;
}

export const gatewayCostAdapter: ProviderCostAdapter = {
  baseUrl: runtimeConfig.AI_GATEWAY_API_BASE_URL,
  parsePayload: parseGatewayPayload,
  lookupGeneration: lookupGatewayGeneration,
};
