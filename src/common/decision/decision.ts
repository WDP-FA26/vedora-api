import { runtimeConfig } from '../../config/runtime-config.js';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationModel,
} from 'ai';

export interface DecisionPolicy<V extends string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<V, string>>;
}

type DecisionState = Parameters<typeof evaluate>[0]['state'];

const DEFAULT_TIMEOUT_MS = runtimeConfig.AI_DECISION_TIMEOUT_MS;
const MAX_RETRIES = runtimeConfig.AI_DECISION_MAX_RETRIES;

export function evaluationModel({
  apiKey,
  modelId,
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
}): Experimental_EvaluationModel {
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
  }).evaluationModel(modelId);
}

export async function decide<V extends string>(
  model: Experimental_EvaluationModel,
  state: DecisionState,
  abortSignal: AbortSignal,
  policy: DecisionPolicy<V>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ choice: V; probabilities?: Record<string, number> }> {
  const { answers } = await evaluate({
    model,
    state,
    questions: { verdict: policy },
    maxRetries: MAX_RETRIES,
    abortSignal: AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]),
  });
  return answers.verdict;
}
