/**
 * Reasoning effort levels accepted by OpenRouter models that support them.
 * Kept in the AI platform so config does not depend on a feature.
 */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
