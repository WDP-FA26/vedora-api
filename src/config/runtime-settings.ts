import { CronTime } from 'cron';
import { numericDefaults, stringDefaults } from './runtime-defaults.js';

export type RuntimeSettings = {
  readonly [K in keyof typeof numericDefaults]: number;
} & {
  readonly [K in keyof typeof stringDefaults]: string;
};

const fractional = new Set<string>([
  'RECIPE_INGREDIENT_MAX_QUANTITY',
  'FEED_FRESHNESS_WEIGHT',
  'KNOWLEDGE_MIN_RELEVANCE',
  'KNOWLEDGE_MIN_OCR_COVERAGE',
  'TRANSCRIPTION_MAX_NO_SPEECH_PROB',
  'TRANSCRIPTION_MIN_AVG_LOGPROB',
  'CAPTION_MAX_CUE_SECONDS',
  'CAPTION_CUE_GAP_SECONDS',
  'AUDIO_MIN_SILENCE_SECONDS',
  'AUDIO_PADDING_SECONDS',
  'AUDIO_MIN_SPEECH_SECONDS',
]);
const probabilities = new Set<string>([
  'FEED_FRESHNESS_WEIGHT',
  'KNOWLEDGE_MIN_RELEVANCE',
  'KNOWLEDGE_MIN_OCR_COVERAGE',
  'TRANSCRIPTION_MAX_NO_SPEECH_PROB',
]);

/** Pure parser shared by startup validation and tests. It never changes process.env. */
export function parseRuntimeSettings(
  source: Record<string, unknown>,
): RuntimeSettings {
  const values: Record<string, number | string> = {};
  const errors: string[] = [];
  for (const [key, fallback] of Object.entries(numericDefaults)) {
    const raw = source[key] === undefined ? fallback : source[key];
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN;
    const minimum =
      fallback < 0
        ? -100
        : fallback === 0 || probabilities.has(key)
          ? 0
          : Number.EPSILON;
    const maximum = probabilities.has(key) ? 1 : 1_000_000_000;
    if (
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum ||
      (!fractional.has(key) && !Number.isSafeInteger(value))
    ) {
      errors.push(
        `${key} must be a ${fractional.has(key) ? 'finite number' : 'safe integer'} between ${minimum} and ${maximum}`,
      );
    } else values[key] = value;
  }
  for (const [key, fallback] of Object.entries(stringDefaults)) {
    const raw = source[key] === undefined ? fallback : source[key];
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${key} must be a nonempty string`);
      continue;
    }
    const value = raw.trim();
    try {
      if (key.endsWith('_CRON')) {
        if (value.split(/\s+/).length !== 6)
          throw new Error('expected six fields');
        new CronTime(value);
      } else if (key.endsWith('_TIMEZONE')) {
        new Intl.DateTimeFormat('en-CA', { timeZone: value }).format();
      } else if (key.endsWith('_URL')) {
        const url = new URL(value);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('invalid HTTP URL');
      } else if (key === 'AI_IMAGE_ALLOWED_ASPECT_RATIOS') {
        const supported = new Set(['1:1', '4:3', '3:4', '16:9']);
        if (value.split(',').some((ratio) => !supported.has(ratio.trim())))
          throw new Error('unsupported aspect ratio');
      } else if (key === 'KNOWLEDGE_OCR_ENGINE' && value !== 'mistral-ocr') {
        throw new Error(
          'only mistral-ocr is supported by this response parser',
        );
      }
      values[key] = value;
    } catch {
      errors.push(`${key} has an invalid or unsupported value`);
    }
  }
  const number = (key: keyof typeof numericDefaults) => values[key] as number;
  const atMost = (
    a: keyof typeof numericDefaults,
    b: keyof typeof numericDefaults,
  ) => {
    if (number(a) > number(b)) errors.push(`${a} must not exceed ${b}`);
  };
  atMost('PAGINATION_DEFAULT_LIMIT', 'PAGINATION_MAX_LIMIT');
  atMost('ADMIN_PAGINATION_DEFAULT_LIMIT', 'ADMIN_PAGINATION_MAX_LIMIT');
  atMost('ADMIN_REPORT_DEFAULT_DAYS', 'ADMIN_REPORT_MAX_DAYS');
  atMost('AUTH_USERNAME_MIN_LENGTH', 'AUTH_USERNAME_MAX_LENGTH');
  atMost(
    'VERIFICATION_STATEMENT_MIN_LENGTH',
    'VERIFICATION_STATEMENT_MAX_LENGTH',
  );
  atMost('KNOWLEDGE_RESULT_LIMIT', 'KNOWLEDGE_CANDIDATE_LIMIT');
  atMost('KNOWLEDGE_CANDIDATE_LIMIT', 'KNOWLEDGE_PREFETCH_LIMIT');
  atMost('KNOWLEDGE_MIN_IMAGE_PX', 'KNOWLEDGE_MAX_IMAGE_PX');
  atMost('MODERATION_IMAGE_MIN_SIDE_PX', 'MODERATION_IMAGE_MAX_SIDE_PX');
  atMost('MODERATION_VIDEO_MIN_FRAMES', 'MODERATION_VIDEO_MAX_FRAMES');
  if (number('AUTH_BCRYPT_ROUNDS') < 4 || number('AUTH_BCRYPT_ROUNDS') > 16)
    errors.push('AUTH_BCRYPT_ROUNDS must be between 4 and 16');
  if (number('AUTH_OTP_LENGTH') < 4 || number('AUTH_OTP_LENGTH') > 10)
    errors.push('AUTH_OTP_LENGTH must be between 4 and 10');
  if (
    number('PAYMENT_CODE_SUFFIX_LENGTH') < 4 ||
    number('PAYMENT_CODE_SUFFIX_LENGTH') > 9
  )
    errors.push('PAYMENT_CODE_SUFFIX_LENGTH must be between 4 and 9');
  if (number('AUTH_PASSWORD_MIN_LENGTH') > 72)
    errors.push(
      'AUTH_PASSWORD_MIN_LENGTH must not exceed the bcrypt byte limit',
    );
  if (number('KNOWLEDGE_JPEG_QUALITY') > 100)
    errors.push('KNOWLEDGE_JPEG_QUALITY must not exceed 100');
  if (
    !(values.AI_IMAGE_ALLOWED_ASPECT_RATIOS as string | undefined)
      ?.split(',')
      .map((ratio) => ratio.trim())
      .includes(values.AI_IMAGE_DEFAULT_ASPECT_RATIO as string)
  )
    errors.push(
      'AI_IMAGE_DEFAULT_ASPECT_RATIO must be included in AI_IMAGE_ALLOWED_ASPECT_RATIOS',
    );
  if (errors.length)
    throw new Error(`Runtime config validation error: ${errors.join('; ')}`);
  return Object.freeze(values) as RuntimeSettings;
}
