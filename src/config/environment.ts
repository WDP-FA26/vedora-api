import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import {
  DEFAULT_CONTENT_MODERATION_MODEL,
  DEFAULT_MODERATION_MODEL,
} from '../ai/openrouter.js';
import { REASONING_EFFORTS } from '../ai/reasoning.js';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0' || value === '' || value == null)
    return false;
  return value;
};

export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  API_PREFIX = 'api/v1';

  @IsString()
  CORS_ORIGIN = '*';

  @IsString()
  @Matches(/^mongodb(\+srv)?:\/\//, {
    message: 'DATABASE_URL must be a mongodb:// or mongodb+srv:// URL',
  })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_ACCESS_TTL = 3600;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31536000)
  REFRESH_TOKEN_TTL = 2592000;

  @IsString()
  GOOGLE_CLIENT_ID = '';

  @IsString()
  GOOGLE_CLIENT_SECRET = '';

  @ValidateIf((env: EnvironmentVariables) => env.GOOGLE_CALLBACK_URL !== '')
  @IsUrl({ require_tld: false })
  GOOGLE_CALLBACK_URL = '';

  @ValidateIf((env: EnvironmentVariables) => env.NODE_ENV === 'production')
  @IsString()
  @IsNotEmpty()
  RESEND_API_KEY = '';

  @IsString()
  MAIL_FROM = 'Vedora <onboarding@resend.dev>';

  @IsUrl({ require_tld: false })
  FRONTEND_URL = 'http://localhost:3000';

  @IsString()
  CLOUDINARY_CLOUD_NAME = '';

  @IsString()
  CLOUDINARY_API_KEY = '';

  @IsString()
  CLOUDINARY_API_SECRET = '';

  @IsString()
  CLOUDINARY_FOLDER = 'vedora';

  @Transform(toBoolean)
  @IsBoolean()
  CLOUDINARY_WEBHOOKS_ENABLED = false;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  MAX_VIDEO_DURATION_SEC = 180;

  @Transform(toBoolean)
  @IsBoolean()
  CAPTIONS_ENABLED = true;

  @IsString()
  TRANSCRIPTION_MODEL = 'elevenlabs/scribe-v2';

  @IsString()
  @IsNotEmpty()
  OPENROUTER_API_KEY!: string;

  @IsString()
  OPENROUTER_MODEL = 'openrouter/auto';

  @IsIn(REASONING_EFFORTS)
  OPENROUTER_REASONING_EFFORT = 'low';

  @ValidateIf((env: EnvironmentVariables) => env.STORAGE_ENDPOINT !== '')
  @IsUrl({ require_tld: false })
  STORAGE_ENDPOINT = '';

  @ValidateIf((env: EnvironmentVariables) => env.STORAGE_PUBLIC_URL !== '')
  @IsUrl({ require_tld: false })
  STORAGE_PUBLIC_URL = '';

  @IsString()
  STORAGE_ACCESS_KEY = '';

  @IsString()
  STORAGE_SECRET_KEY = '';

  @IsString()
  STORAGE_REGION = 'us-east-1';

  @IsString()
  STORAGE_KNOWLEDGE_BUCKET = 'vedora-knowledge';

  @IsString()
  STORAGE_PROFILES_BUCKET = 'vedora-profiles';

  @IsString()
  STORAGE_BLOGS_BUCKET = 'vedora-blogs';

  @IsString()
  STORAGE_VERIFICATIONS_BUCKET = 'vedora-verifications';

  @IsString()
  STORAGE_WEBHOOK_TOKEN = '';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  MAX_KNOWLEDGE_FILE_MB = 50;

  @IsUrl({ require_tld: false })
  QDRANT_URL!: string;

  @IsString()
  QDRANT_API_KEY = '';

  @IsString()
  QDRANT_COLLECTION = 'vedora_knowledge';

  @IsString()
  OPENROUTER_EMBEDDING_MODEL = 'google/gemini-embedding-2';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

  @IsString()
  OPENROUTER_MODERATION_MODEL = DEFAULT_MODERATION_MODEL;

  @IsString()
  OPENROUTER_CONTENT_MODERATION_MODEL = DEFAULT_CONTENT_MODERATION_MODEL;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  MODERATION_REJECT_THRESHOLD = 0.85;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  MODERATION_REVIEW_THRESHOLD = 0.3;

  @ValidateIf((env: EnvironmentVariables) => env.NODE_ENV === 'production')
  @IsString()
  @IsNotEmpty()
  TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  GUEST_DAILY_MESSAGES = 5;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  GUEST_DAILY_MESSAGES_PER_IP = 20;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  GUEST_DAILY_BUDGET = 500;

  @IsString()
  CLIENT_IP_HEADER = '';

  @IsString()
  QDRANT_POSTS_COLLECTION = 'vedora_posts_v2';

  @IsString()
  POST_SEARCH_EMBEDDING_MODEL = 'google/gemini-embedding-2';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  POST_SEARCH_EMBEDDING_DIMENSIONS = 768;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  POST_SEARCH_MIN_SCORE = 0.65;

  @IsString()
  OPENROUTER_RERANK_MODEL = 'cohere/rerank-v3.5';

  @IsString()
  BLOG_AI_MODEL = '';

  @IsString()
  OPENROUTER_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

  @ValidateIf((env: EnvironmentVariables) => env.PAYMENT_REDIS_URL !== '')
  @IsUrl({
    protocols: ['redis', 'rediss'],
    require_protocol: true,
    require_tld: false,
  })
  PAYMENT_REDIS_URL = '';

  @Matches(/^[A-Za-z0-9:_-]{1,100}$/)
  PAYMENT_EVENTS_CHANNEL = 'vedora:payments:v1';

  // New catalogue uses distinct env names so an old PRO=49000 cannot price v2 Pro.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  SUBSCRIPTION_PLUS_PRICE_VND = 49000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  SUBSCRIPTION_PRO_PRICE_VND = 99000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  BILLING_DURATION_DAYS = 30;

  @Transform(toBoolean)
  @IsBoolean()
  SEPAY_PAYMENT_ENABLED = false;

  @IsIn(['bank_transfer_qr'])
  SEPAY_PAYMENT_FLOW = 'bank_transfer_qr';

  @ValidateIf((env: EnvironmentVariables) => env.SEPAY_PAYMENT_ENABLED)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  SEPAY_QR_BANK_CODE = '';

  @ValidateIf((env: EnvironmentVariables) => env.SEPAY_PAYMENT_ENABLED)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  SEPAY_BANK_GATEWAY = '';

  @ValidateIf((env: EnvironmentVariables) => env.SEPAY_PAYMENT_ENABLED)
  @Matches(/^[A-Za-z0-9]{1,100}$/)
  SEPAY_QR_ACCOUNT_NUMBER = '';

  @ValidateIf((env: EnvironmentVariables) => env.SEPAY_PAYMENT_ENABLED)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  SEPAY_QR_ACCOUNT_HOLDER = '';

  @IsString()
  @MaxLength(100)
  SEPAY_QR_STORE_NAME = 'Vedora';

  @ValidateIf(
    (env: EnvironmentVariables) => env.SEPAY_QR_TRANSFER_PREFIX !== '',
  )
  @Matches(/^[A-Z0-9]{1,30}$/)
  SEPAY_QR_TRANSFER_PREFIX = '';

  @Matches(/^[A-Z][A-Z0-9]{1,4}$/)
  SEPAY_PAYMENT_CODE_PREFIX = 'VED';

  @ValidateIf(
    (env: EnvironmentVariables) =>
      env.SEPAY_PAYMENT_ENABLED || env.SEPAY_BANK_WEBHOOK_API_KEY !== '',
  )
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  SEPAY_BANK_WEBHOOK_API_KEY = '';
}

export function validateEnvironment(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const source = { ...config };
  if (!source.TURNSTILE_SECRET_KEY && source.NODE_ENV !== 'production')
    source.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET;
  const instance = plainToInstance(EnvironmentVariables, source);
  const errors = validateSync(instance, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });
  if (errors.length > 0) {
    const messages = errors
      .flatMap((error) => Object.values(error.constraints ?? {}))
      .join('; ');
    throw new Error(`Config validation error: ${messages}`);
  }
  return instance;
}
