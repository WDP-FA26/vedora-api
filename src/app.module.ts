import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import Joi from 'joi';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { BlobModule } from './blob/blob.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MailModule } from './mail/mail.module';
import { MediaModule } from './media/media.module';
import { MuxModule } from './mux/mux.module';
import { NutritionChatModule } from './nutrition-chat/nutrition-chat.module';
import { REASONING_EFFORTS } from './nutrition-chat/nutrition-chat.agent';
import { PostsModule } from './posts/posts.module';
import { PrismaModule } from './prisma/prisma.module';
import { QdrantModule } from './qdrant/qdrant.module';
import { UsersModule } from './users/users.module';

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
        // Origin the browser uploads videos from (Mux direct-upload CORS).
        FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),
        // Empty: video uploads answer 503.
        MUX_TOKEN_ID: Joi.string().allow('').default(''),
        MUX_TOKEN_SECRET: Joi.string().allow('').default(''),
        // Empty: no webhooks; pending media is refreshed from Mux on read.
        MUX_WEBHOOK_SECRET: Joi.string().allow('').default(''),
        MAX_VIDEO_DURATION_SEC: Joi.number().integer().positive().default(180),
        OPENROUTER_API_KEY: Joi.string().required(),
        OPENROUTER_MODEL: Joi.string().default('openrouter/auto'),
        // How long reasoning models think before answering.
        OPENROUTER_REASONING_EFFORT: Joi.string()
          .valid(...REASONING_EFFORTS)
          .default('low'),
        // Empty: knowledge-base uploads answer 503.
        BLOB_READ_WRITE_TOKEN: Joi.string().allow('').default(''),
        // Public URL of POST /webhooks/vercel-blob; empty disables uploads
        // (503). Locally, point it at a tunnel.
        BLOB_CALLBACK_URL: Joi.string().uri().allow('').default(''),
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
        OPENROUTER_MODERATION_MODEL: Joi.string().default(
          'openai/gpt-oss-safeguard-20b',
        ),
        // Empty: no reranking.
        OPENROUTER_RERANK_MODEL: Joi.string()
          .allow('')
          .default('cohere/rerank-v3.5'),
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    MailModule,
    MuxModule,
    BlobModule,
    QdrantModule,
    AuthModule,
    HealthModule,
    UsersModule,
    MediaModule,
    PostsModule,
    NutritionChatModule,
    KnowledgeModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
