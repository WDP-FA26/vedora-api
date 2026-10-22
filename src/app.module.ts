import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import Joi from 'joi';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { StorageWebhookModule } from './storage/storage-webhook.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { MailModule } from './mail/mail.module';
import { MealPlanModule } from './meal-plan/meal-plan.module';
import { MediaModule } from './media/media.module';
import { NutritionChatModule } from './nutrition-chat/nutrition-chat.module';
import { REASONING_EFFORTS } from './nutrition-chat/nutrition-chat.agent';
import { NotificationsModule } from './notifications/notifications.module';
import { PostsModule } from './posts/posts.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfilesModule } from './profiles/profiles.module';
import { QdrantModule } from './qdrant/qdrant.module';
import { RecipesModule } from './recipes/recipes.module';
import { UsersModule } from './users/users.module';
import { VerificationModule } from './verification/verification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().port().default(3000),
        API_PREFIX: Joi.string().default('api/v1'),
        CORS_ORIGIN: Joi.string().default('*'),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_ACCESS_TTL: Joi.number().integer().positive().default(3600),
        REFRESH_TOKEN_TTL: Joi.number()
          .integer()
          .positive()
          .max(31536000)
          .default(2592000),
        GOOGLE_CLIENT_ID: Joi.string().allow('').default(''),
        GOOGLE_CLIENT_SECRET: Joi.string().allow('').default(''),
        GOOGLE_CALLBACK_URL: Joi.string().uri().allow('').default(''),
        // Empty outside production: verification codes go to the log instead.
        RESEND_API_KEY: Joi.string().when('NODE_ENV', {
          is: 'production',
          then: Joi.required(),
          otherwise: Joi.allow('').default(''),
        }),
        MAIL_FROM: Joi.string().default('Vedora <onboarding@resend.dev>'),
        FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),
        // Empty: video uploads answer 503.
        CLOUDINARY_CLOUD_NAME: Joi.string().allow('').default(''),
        CLOUDINARY_API_KEY: Joi.string().allow('').default(''),
        CLOUDINARY_API_SECRET: Joi.string().allow('').default(''),
        CLOUDINARY_FOLDER: Joi.string().default('vedora'),
        // The console's notification URL points at /webhooks/cloudinary.
        // False: pending media is refreshed from the Admin API on read.
        CLOUDINARY_WEBHOOKS_ENABLED: Joi.boolean().default(false),
        MAX_VIDEO_DURATION_SEC: Joi.number().integer().positive().default(180),
        // Transcribe published videos with Whisper and translate them.
        CAPTIONS_ENABLED: Joi.boolean().default(true),
        TRANSCRIPTION_MODEL: Joi.string().default('openai/whisper-large-v3'),
        OPENROUTER_API_KEY: Joi.string().required(),
        OPENROUTER_MODEL: Joi.string().default('openrouter/auto'),
        // How long reasoning models think before answering.
        OPENROUTER_REASONING_EFFORT: Joi.string()
          .valid(...REASONING_EFFORTS)
          .default('low'),
        STORAGE_ENDPOINT: Joi.string().uri().allow('').default(''),
        STORAGE_PUBLIC_URL: Joi.string().uri().allow('').default(''),
        STORAGE_ACCESS_KEY: Joi.string().allow('').default(''),
        STORAGE_SECRET_KEY: Joi.string().allow('').default(''),
        STORAGE_REGION: Joi.string().default('us-east-1'),
        STORAGE_KNOWLEDGE_BUCKET: Joi.string().default('vedora-knowledge'),
        STORAGE_PROFILES_BUCKET: Joi.string().default('vedora-profiles'),
        STORAGE_BLOGS_BUCKET: Joi.string().default('vedora-blogs'),
        STORAGE_VERIFICATIONS_BUCKET: Joi.string().default(
          'vedora-verifications',
        ),
        STORAGE_WEBHOOK_TOKEN: Joi.string().allow('').default(''),
        MAX_KNOWLEDGE_FILE_MB: Joi.number().integer().positive().default(50),
        QDRANT_URL: Joi.string().uri().required(),
        QDRANT_API_KEY: Joi.string().allow('').default(''),
        QDRANT_COLLECTION: Joi.string().default('vedora_knowledge'),
        OPENROUTER_EMBEDDING_MODEL: Joi.string().default(
          'google/gemini-embedding-2',
        ),
        // Changing it needs a new QDRANT_COLLECTION.
        KNOWLEDGE_EMBEDDING_DIMENSIONS: Joi.number()
          .integer()
          .positive()
          .default(1536),
        // Empty: no reranking.
        OPENROUTER_MODERATION_MODEL: Joi.string().default(
          'openai/gpt-oss-safeguard-20b',
        ),
        // Cloudflare's always-pass test secret outside production.
        TURNSTILE_SECRET_KEY: Joi.string()
          .empty('')
          .when('NODE_ENV', {
            is: 'production',
            then: Joi.required(),
            otherwise: Joi.string().default(
              '1x0000000000000000000000000000000AA',
            ),
          }),
        // Guest chat caps per day: per session, per IP, and for all guests.
        GUEST_DAILY_MESSAGES: Joi.number().integer().positive().default(5),
        GUEST_DAILY_MESSAGES_PER_IP: Joi.number()
          .integer()
          .positive()
          .default(20),
        GUEST_DAILY_BUDGET: Joi.number().integer().positive().default(500),
        // Header carrying the visitor's IP, e.g. cf-connecting-ip behind a
        // Cloudflare Tunnel. Empty: the socket address.
        CLIENT_IP_HEADER: Joi.string().allow('').default(''),
        // Post search lives in its own collection, apart from the knowledge
        // base. Changing the model or size needs a new QDRANT_POSTS_COLLECTION;
        // the API reindexes every post into it.
        QDRANT_POSTS_COLLECTION: Joi.string().default('vedora_posts'),
        POST_SEARCH_EMBEDDING_MODEL: Joi.string().default(
          'google/gemini-embedding-2',
        ),
        POST_SEARCH_EMBEDDING_DIMENSIONS: Joi.number()
          .integer()
          .positive()
          .default(768),
        // Cosine similarity a post needs to match by meaning alone.
        POST_SEARCH_MIN_SCORE: Joi.number().min(0).max(1).default(0.65),
        OPENROUTER_RERANK_MODEL: Joi.string()
          .allow('')
          .default('cohere/rerank-v3.5'),
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    MailModule,
    CloudinaryModule,
    StorageModule,
    QdrantModule,
    RecipesModule,
    MealPlanModule,
    AuthModule,
    HealthModule,
    UsersModule,
    MediaModule,
    PostsModule,
    NotificationsModule,
    NutritionChatModule,
    KnowledgeModule,
    ProfilesModule,
    VerificationModule,
    StorageWebhookModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
