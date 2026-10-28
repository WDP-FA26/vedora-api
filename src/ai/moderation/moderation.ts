import { setTimeout as sleep } from 'node:timers/promises';
import { generateText, type LanguageModel, Output } from 'ai';
import { z } from 'zod';

export const MODERATION_VERDICTS = [
  'allow',
  'off_topic',
  'unsupported_language',
  'self_harm',
  'injection',
  'harmful',
] as const;
export type ModerationVerdict = (typeof MODERATION_VERDICTS)[number];

const moderationOutput = z.object({ verdict: z.enum(MODERATION_VERDICTS) });

const TIMEOUT_MS = 4000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

/**
 * Classifies `message` against a feature's `policy`. gpt-oss-safeguard reads
 * the policy as instructions; the layout (instructions, definitions, criteria,
 * examples, output repeated last) follows OpenAI's safeguard guide.
 */
export async function moderate(
  model: LanguageModel,
  message: string,
  abortSignal: AbortSignal,
  policy: string,
): Promise<ModerationVerdict> {
  const { output } = await generateText({
    model,
    instructions: policy,
    prompt: message,
    output: Output.object({ schema: moderationOutput }),
    maxRetries: 0,
    abortSignal,
  });
  return output.verdict;
}

/**
 * `moderate` with our own short backoff, since the provider sometimes answers
 * 429 and the SDK's backoff would outlast the request timeout.
 */
export async function moderateWithRetry(
  model: LanguageModel,
  message: string,
  abortSignal: AbortSignal,
  policy: string,
  {
    timeoutMs = TIMEOUT_MS,
    attempts = ATTEMPTS,
    retryDelayMs = RETRY_DELAY_MS,
  }: { timeoutMs?: number; attempts?: number; retryDelayMs?: number } = {},
): Promise<ModerationVerdict> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([abortSignal, timeout]);
  for (let attempt = 1; ; attempt++) {
    try {
      return await moderate(model, message, signal, policy);
    } catch (error) {
      if (attempt >= attempts || signal.aborted) throw error;
      await sleep(retryDelayMs * attempt, undefined, { signal }).catch(
        () => undefined,
      );
      if (signal.aborted) throw error;
    }
  }
}
