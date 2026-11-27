import { FeatureUnavailableException } from '../../common/exceptions/feature-unavailable.exception.js';
import type { CacheTtl } from './ai-provider.interface.js';

export const DEFAULT_AI_APP_URL = 'https://vedora-opal.vercel.app';
export const DEFAULT_AI_APP_TITLE = 'Vedora Platform';

export type AiAppAttribution = {
  appUrl: string;
  appTitle: string;
};

export type EphemeralCacheSpec = {
  type: 'ephemeral';
  ttl?: '1h';
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function aiAppAttribution(overrides?: {
  appUrl?: string;
  appTitle?: string;
}): AiAppAttribution {
  return {
    appUrl:
      nonEmpty(overrides?.appUrl) ??
      nonEmpty(process.env.AI_APP_URL) ??
      DEFAULT_AI_APP_URL,
    appTitle:
      nonEmpty(overrides?.appTitle) ??
      nonEmpty(process.env.AI_APP_TITLE) ??
      DEFAULT_AI_APP_TITLE,
  };
}

export function ephemeralCache(ttl: CacheTtl = '1h'): EphemeralCacheSpec {
  if (ttl === '1h') return { type: 'ephemeral', ttl: '1h' };
  return { type: 'ephemeral' };
}

export function providerOrderFrom(value: string): string[] {
  const order: string[] = [];
  for (const slug of value.split(',')) {
    const trimmed = slug.trim();
    if (trimmed) order.push(trimmed);
  }
  return order;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function asObject(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

export function lookupUnavailable(): FeatureUnavailableException {
  return new FeatureUnavailableException(
    'SERVICE_UNAVAILABLE',
    'Provider generation lookup unavailable; retry later',
  );
}

export function mismatchedGeneration(): FeatureUnavailableException {
  return new FeatureUnavailableException(
    'SERVICE_UNAVAILABLE',
    'Provider returned mismatched generation ID',
  );
}
