import type { INestApplication } from '@nestjs/common';
import { APICallError } from 'ai';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import type { App } from 'supertest/types.js';
import { AppModule } from '@src/app.module.js';
import {
  CONTENT_MODERATION_MODEL,
  type ModerationModel,
} from '@src/moderation/content-moderation.service.js';
import { FakeModel, type FakeModelCall } from '@nestjs/ai/testing';
import { configureApp } from '@src/app.setup.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { MediaService } from '@src/media/media.service.js';
import { QdrantService } from '@src/qdrant/qdrant.service.js';
import { StorageService } from '@src/storage/storage.service.js';
import { InMemoryQdrantService } from './in-memory-qdrant.js';
import { InMemoryStorageService } from './in-memory-storage.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

export interface E2eApp {
  app: INestApplication<App>;
  mongo: MongoService;
  connection: Connection;
  sign(user: { id: string; username: string }): Promise<string>;
  settled(): Promise<void>;
  close(): Promise<void>;
}

export const VIOLATION_MARKER = 'VIOLATION';
export const BORDERLINE_MARKER = 'BORDERLINE';
export const PROVIDER_BLOCKED_MARKER = 'PROVIDERBLOCKED';

const CHOICE_MARKER = /CHOICE:([a-z_0-9]+)/;

function reviewedContent(call: FakeModelCall): string {
  return JSON.stringify(
    call.options.prompt.filter(({ role }) => role === 'user'),
  );
}

function answerReview(call: FakeModelCall) {
  const content = reviewedContent(call);
  if (content.includes(PROVIDER_BLOCKED_MARKER)) {
    return new APICallError({
      message: 'Input blocked',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"code":"prohibited_content"}}',
    });
  }
  const marked = CHOICE_MARKER.exec(content);
  if (marked && call.instructions?.includes(`\n${marked[1]}: `)) {
    return highRisk(marked[1], marked[0]);
  }
  if (content.includes(VIOLATION_MARKER)) {
    return highRisk('violence', VIOLATION_MARKER);
  }
  if (content.includes(BORDERLINE_MARKER)) {
    return {
      object: {
        riskLevel: 2,
        category: 'violence',
        summary: 'Có thể là bạo lực.',
        evidence: [],
      },
    };
  }
  return {
    object: { riskLevel: 0, category: null, summary: 'Ổn.', evidence: [] },
  };
}

function highRisk(category: string, quote: string) {
  return {
    object: {
      riskLevel: 3,
      category,
      summary: 'Vi phạm rõ ràng.',
      evidence: [{ category, reason: 'Vi phạm.', quote, imageIndex: null }],
    },
  };
}

const fakeReviewer: ModerationModel = {
  id: 'fake/haiku',
  model: new FakeModel(answerReview),
};

export async function createE2eApp(
  prefix: string,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<E2eApp> {
  process.env.DATABASE_URL = createTestMongoUrl(prefix);
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONTENT_MODERATION_MODEL)
    .useValue(fakeReviewer);
  if (process.env.TEST_USE_REAL_SERVICES !== 'true') {
    builder = builder
      .overrideProvider(QdrantService)
      .useValue(new InMemoryQdrantService())
      .overrideProvider(StorageService)
      .useClass(InMemoryStorageService);
  }
  const moduleRef = await override(builder).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  const connection = await prepareTestDatabase(app);
  return {
    app,
    mongo: app.get(MongoService),
    connection,
    sign: (user) =>
      app.get(JwtService).signAsync({ sub: user.id, username: user.username }),
    settled: () => app.get(MediaService).whenSettled(),
    close: async () => {
      await dropTestDatabase(app);
      await app.close();
    },
  };
}
