export const MODERATION_MODEL = Symbol('MODERATION_MODEL');

export const MODERATION_VERDICTS = [
  'allow',
  'off_topic',
  'unsupported_language',
  'self_harm',
  'injection',
  'harmful',
] as const;
export type ModerationVerdict = (typeof MODERATION_VERDICTS)[number];
