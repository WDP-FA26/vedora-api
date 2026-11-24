import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import {
  numericDefaults,
  stringDefaults,
} from '@src/config/runtime-defaults.js';
import { parseRuntimeSettings } from '@src/config/runtime-settings.js';
import { validateEnvironment } from '@src/config/environment.js';
import { nextCalendarDay, zonedMidnight } from '@src/config/time-zone.js';

describe('backend operational environment settings', () => {
  it('preserves captured defaults and explicit changes from main, including units', () => {
    const audit = JSON.parse(
      readFileSync(
        new URL(
          '../../fixtures/runtime-defaults-before-refactor.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      file: string;
      env: keyof typeof numericDefaults | keyof typeof stringDefaults;
      original: string | number;
      upstreamOriginal?: string | number;
      multiplier: number;
    }[];
    const defaults = parseRuntimeSettings({});
    expect(audit).toHaveLength(155);
    for (const entry of audit) {
      const value = defaults[entry.env];
      expect(
        typeof value === 'number' ? value * entry.multiplier : value,
        `${entry.file}: ${entry.env}`,
      ).toBe(entry.upstreamOriginal ?? entry.original);
    }
  });

  it('accepts explicit valid overrides without mutating the process environment', () => {
    const before = process.env.POST_MAX_LENGTH;
    const parsed = parseRuntimeSettings({
      POST_MAX_LENGTH: '4567',
      AUTH_OTP_LENGTH: '8',
      KNOWLEDGE_MIN_RELEVANCE: '0.15',
      PAYMENT_EXPIRATION_CRON: '*/5 * * * * *',
      APP_TIMEZONE: 'UTC',
    });
    expect(parsed.POST_MAX_LENGTH).toBe(4567);
    expect(parsed.AUTH_OTP_LENGTH).toBe(8);
    expect(parsed.KNOWLEDGE_MIN_RELEVANCE).toBe(0.15);
    expect(parsed.APP_TIMEZONE).toBe('UTC');
    expect(process.env.POST_MAX_LENGTH).toBe(before);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['POST_MAX_LENGTH', ''],
    ['POST_MAX_LENGTH', '-1'],
    ['POST_MAX_LENGTH', '1.5'],
    ['POST_MAX_LENGTH', 'NaN'],
    ['POST_MAX_LENGTH', 'Infinity'],
    ['POST_MAX_LENGTH', 'junk'],
    ['KNOWLEDGE_MIN_RELEVANCE', '1.1'],
    ['KNOWLEDGE_MIN_RELEVANCE', '-0.1'],
    ['AUTH_OTP_LENGTH', '12'],
    ['PAYMENT_CODE_SUFFIX_LENGTH', '10'],
    ['AUTH_BCRYPT_ROUNDS', '3'],
    ['AUTH_BCRYPT_ROUNDS', '31'],
    ['AUTH_PASSWORD_MIN_LENGTH', '73'],
    ['KNOWLEDGE_JPEG_QUALITY', '101'],
    ['APP_TIMEZONE', 'Not/A-Timezone'],
    ['PAYMENT_EXPIRATION_CRON', '* * * * *'],
    ['PAYMENT_EXPIRATION_CRON', '99 * * * * *'],
    ['OPENROUTER_API_BASE_URL', 'file:///tmp'],
    ['TURNSTILE_VERIFY_URL', 'https://user:secret@example.test'],
    ['AI_IMAGE_ALLOWED_ASPECT_RATIOS', '1:1,unsupported'],
    ['KNOWLEDGE_OCR_ENGINE', 'unsupported-engine'],
    ['AI_IMAGE_DEFAULT_ASPECT_RATIO', '2:1'],
    ['OPENROUTER_API_BASE_URL', 'https://example.test/api/v1?key=secret'],
  ])('rejects invalid %s=%s at startup', (key, value) => {
    expect(() => parseRuntimeSettings({ [key]: value })).toThrow(key);
  });

  it.each([
    { PAGINATION_DEFAULT_LIMIT: 60, PAGINATION_MAX_LIMIT: 50 },
    { ADMIN_REPORT_DEFAULT_DAYS: 91, ADMIN_REPORT_MAX_DAYS: 90 },
    { AUTH_USERNAME_MIN_LENGTH: 40, AUTH_USERNAME_MAX_LENGTH: 30 },
    { KNOWLEDGE_RESULT_LIMIT: 21, KNOWLEDGE_CANDIDATE_LIMIT: 20 },
    { KNOWLEDGE_CANDIDATE_LIMIT: 41, KNOWLEDGE_PREFETCH_LIMIT: 40 },
    { MODERATION_IMAGE_MIN_SIDE_PX: 1500, MODERATION_IMAGE_MAX_SIDE_PX: 1280 },
  ])('rejects inconsistent related settings: %j', (values) => {
    expect(() => parseRuntimeSettings(values)).toThrow('must not exceed');
  });

  it('requires a real explicitly supplied CAPTCHA key in production while preserving development defaults', () => {
    const base = {
      DATABASE_URL: 'mongodb://localhost:27017/fixture',
      JWT_SECRET: 'x'.repeat(32),
      OPENROUTER_API_KEY: 'fixture',
      QDRANT_URL: 'http://localhost:6333',
      RESEND_API_KEY: 'fixture',
    };
    expect(() =>
      validateEnvironment({ ...base, NODE_ENV: 'production' }),
    ).toThrow('TURNSTILE_SECRET_KEY');
    expect(() =>
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }),
    ).toThrow('test key');
    expect(
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        TURNSTILE_SECRET_KEY: 'fixture-production-secret',
        POST_MAX_LENGTH: '999',
      }).POST_MAX_LENGTH,
    ).toBe(999);
    expect(
      validateEnvironment({ ...base, NODE_ENV: 'development' })
        .TURNSTILE_SECRET_KEY,
    ).toBe('1x0000000000000000000000000000000AA');
  });

  it('keeps Bangkok boundaries and correctly handles UTC and DST when timezone is configured', () => {
    expect(zonedMidnight('2026-11-18', 'Asia/Bangkok').toISOString()).toBe(
      '2026-11-17T17:00:00.000Z',
    );
    expect(zonedMidnight('2026-11-18', 'UTC').toISOString()).toBe(
      '2026-11-18T00:00:00.000Z',
    );
    const start = zonedMidnight('2026-03-08', 'America/New_York');
    const end = zonedMidnight(
      nextCalendarDay('2026-03-08'),
      'America/New_York',
    );
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });
});
