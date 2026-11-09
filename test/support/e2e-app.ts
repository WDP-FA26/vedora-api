import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { CONTENT_MODERATION_MODEL } from '../../src/moderation/content-moderation.service.js';
import { configureApp } from '../../src/app.setup.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
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
  close(): Promise<void>;
}

export const VIOLATION_MARKER = 'VIOLATION';
export const BORDERLINE_MARKER = 'BORDERLINE';

const CHOICE_MARKER = /CHOICE:([a-z_0-9]+)/;

function distribution(
  keys: string[],
  top: string,
  chance: number,
): Record<string, number> {
  const chances: Record<string, number> = {};
  for (const key of keys) chances[key] = 0;
  chances.allow = 1 - chance;
  chances[top] = (chances[top] ?? 0) + chance;
  return chances;
}

const fakeJev = {
  specificationVersion: 'v4',
  provider: 'e2e',
  modelId: 'fake-jev',
  supportedQuestionTypes: ['choice'],
  doEvaluate: ({
    state,
    questions,
  }: {
    state: unknown;
    questions: Record<string, { criteria: Record<string, unknown> }>;
  }) => {
    const text = JSON.stringify(state);
    const keys = Object.keys(questions.verdict?.criteria ?? {});
    let choice = 'allow';
    let probabilities = distribution(keys, 'violence', 0.01);
    const marked = CHOICE_MARKER.exec(text)?.[1];
    if (marked && keys.includes(marked)) {
      choice = marked;
      probabilities = distribution(keys, marked, 0.98);
    } else if (text.includes(VIOLATION_MARKER)) {
      choice = 'violence';
      probabilities = distribution(keys, 'violence', 0.98);
    } else if (text.includes(BORDERLINE_MARKER)) {
      choice = 'violence';
      probabilities = distribution(keys, 'violence', 0.6);
    }
    return Promise.resolve({
      answers: { verdict: { type: 'choice' as const, choice, probabilities } },
      warnings: [],
    });
  },
};

export async function createE2eApp(
  prefix: string,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<E2eApp> {
  process.env.DATABASE_URL = createTestMongoUrl(prefix);
  const moduleRef = await override(
    Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONTENT_MODERATION_MODEL)
      .useValue(fakeJev),
  ).compile();
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
    close: async () => {
      await dropTestDatabase(app);
      await app.close();
    },
  };
}
