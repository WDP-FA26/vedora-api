export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** OpenRouter's `reasoning` request field; the thinking itself is never returned. */
// A type alias, not an interface, so it stays assignable to the AI SDK's JSON provider options.
export type ReasoningSetting = {
  effort: ReasoningEffort;
  exclude: true;
};

export function reasoningSetting(effort: ReasoningEffort): ReasoningSetting {
  return { effort, exclude: true };
}
