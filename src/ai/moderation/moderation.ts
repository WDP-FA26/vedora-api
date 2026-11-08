import type { AiService } from '@nestjs/ai';
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

/**
 * Classifies `message` against a feature's `policy`. gpt-oss-safeguard reads
 * the policy as instructions; the layout (instructions, definitions, criteria,
 * examples, output repeated last) follows OpenAI's safeguard guide.
 *
 * Timeouts and retries come from the `moderation` model in `AiModule`.
 */
export async function moderate(
  ai: AiService,
  message: string,
  abortSignal: AbortSignal,
  policy: string,
): Promise<ModerationVerdict> {
  const { object } = await ai.generateObject({
    model: 'moderation',
    label: 'moderation',
    instructions: policy,
    prompt: message,
    schema: moderationOutput,
    abortSignal,
  });
  return object.verdict;
}
