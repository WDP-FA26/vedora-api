import type { ConfigService } from '@nestjs/config';

export const MODERATION_MODES = ['shadow', 'enforce'] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];

/**
 * `shadow`: System 2 reviews flagged posts and the router's outcome is only
 * recorded; System 1's thresholds still decide. `enforce`: the router's
 * outcome is applied, and the manipulation rule rejects outright.
 */
export function moderationMode(config: ConfigService): ModerationMode {
  return config.get<string>('MODERATION_MODE') === 'enforce'
    ? 'enforce'
    : 'shadow';
}

export function isEnforced(config: ConfigService): boolean {
  return moderationMode(config) === 'enforce';
}
