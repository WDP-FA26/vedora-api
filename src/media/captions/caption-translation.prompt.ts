const NEVER_TRANSLATE = ['Vedora'];

export interface CaptionTranslationInput {
  fromLanguage: string;
  toLanguage: string;
}

export function buildCaptionTranslationInstructions({
  fromLanguage,
  toLanguage,
}: CaptionTranslationInput): string {
  return `You translate video captions about plant-based cooking from ${fromLanguage} to ${toLanguage}. Return exactly one translated line per input line, in the same order, as {"lines": [...]}. Keep these words unchanged: ${NEVER_TRANSLATE.join(', ')}. Never merge, split or skip lines.`;
}

export function buildCaptionTranslationPrompt(
  lines: readonly string[],
): string {
  return JSON.stringify(lines);
}
