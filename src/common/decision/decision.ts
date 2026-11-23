import { runtimeConfig } from '../../config/runtime-config.js';
import {
  createOpenRouter,
  type OpenRouterProvider,
} from '@openrouter/ai-sdk-provider';
import { APICallError, InvalidResponseDataError, RetryError } from 'ai';

export interface DecisionPolicy<V extends string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<V, string>>;
}

/**
 * An OpenRouter Decisions model. `decide` calls it directly instead of
 * through the AI SDK's `experimental_decide`: since ai 7.0.180 the SDK only
 * accepts text, file and JSON parts and rewrites a string state into parts,
 * while OpenRouter reads `state` as written (strings, turn objects and
 * top-level `image_url` parts for images).
 */
export type DecisionModel = Pick<
  ReturnType<OpenRouterProvider['evaluationModel']>,
  'provider' | 'modelId' | 'doEvaluate'
>;

export type DecisionState = Parameters<DecisionModel['doEvaluate']>[0]['state'];

// One budget for the whole call, retries included.
const DEFAULT_TIMEOUT_MS = runtimeConfig.AI_DECISION_TIMEOUT_MS;
const MAX_RETRIES = runtimeConfig.AI_DECISION_MAX_RETRIES;
// The AI SDK's backoff: 2 s, then twice as long each time, unless the
// provider asks for a shorter or reasonable wait in retry-after headers.
const RETRY_INITIAL_DELAY_MS = 2000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_AFTER_MAX_MS = 60_000;

export function evaluationModel({
  apiKey,
  modelId,
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
}): DecisionModel {
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
  }).evaluationModel(modelId);
}

function isRetryable(error: unknown): boolean {
  return APICallError.isInstance(error) && error.isRetryable;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  const headers = error.responseHeaders;
  if (!headers) return undefined;
  const exact = headers['retry-after-ms'];
  if (exact) {
    const ms = parseFloat(exact);
    if (!Number.isNaN(ms)) return ms;
  }
  const after = headers['retry-after'];
  if (!after) return undefined;
  const seconds = parseFloat(after);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  return Date.parse(after) - Date.now();
}

function retryDelayMs(error: unknown, attempt: number): number {
  const backoff = RETRY_INITIAL_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt;
  const requested = retryAfterMs(error);
  if (requested === undefined || Number.isNaN(requested) || requested < 0) {
    return backoff;
  }
  if (requested < RETRY_AFTER_MAX_MS || requested < backoff) return requested;
  return backoff;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('The decision was aborted');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isPolicyChoice<V extends string>(
  policy: DecisionPolicy<V>,
  choice: string,
): choice is V {
  return Object.hasOwn(policy.criteria, choice);
}

/**
 * Asks the model one choice question about `state`. Retryable provider
 * errors are retried with the AI SDK's backoff and retry-after handling: a first
 * non-retryable error is thrown as is, otherwise a `RetryError` holds them all.
 */
export async function decide<V extends string>(
  model: DecisionModel,
  state: DecisionState,
  abortSignal: AbortSignal,
  policy: DecisionPolicy<V>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ choice: V; probabilities?: Record<string, number> }> {
  const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]);
  const errors: unknown[] = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal.throwIfAborted();
    let answers: Awaited<ReturnType<DecisionModel['doEvaluate']>>['answers'];
    try {
      ({ answers } = await model.doEvaluate({
        state,
        questions: { verdict: policy },
        abortSignal: signal,
      }));
    } catch (error) {
      if (signal.aborted) throw error;
      if (!isRetryable(error)) {
        if (errors.length === 0) throw error;
        errors.push(error);
        throw new RetryError({
          message: `Failed after ${errors.length} attempts with a non-retryable error`,
          reason: 'errorNotRetryable',
          errors,
        });
      }
      errors.push(error);
      if (attempt === MAX_RETRIES) break;
      await wait(retryDelayMs(error, attempt), signal);
      continue;
    }
    const verdict = answers.verdict;
    if (verdict?.type !== 'choice' || !isPolicyChoice(policy, verdict.choice)) {
      throw new InvalidResponseDataError({
        data: answers,
        message: 'The decision model did not answer with one of the choices',
      });
    }
    return { choice: verdict.choice, probabilities: verdict.probabilities };
  }
  throw new RetryError({
    message: `Failed after ${errors.length} attempts`,
    reason: 'maxRetriesExceeded',
    errors,
  });
}
