import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MongoService } from '../src/mongo/mongo.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

export interface E2eApp {
  app: INestApplication<App>;
  mongo: MongoService;
  connection: Connection;
  /** An access token for `user`, as login issues it. */
  sign(user: { id: string; username: string }): Promise<string>;
  close(): Promise<void>;
}

/**
 * The whole API on a disposable MongoDB database. `override` replaces other
 * providers, such as external services.
 *
 * `DATABASE_URL` is set before the module compiles; the Mongoose connection
 * reads it when it opens the connection.
 */
export async function createE2eApp(
  prefix: string,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<E2eApp> {
  process.env.DATABASE_URL = createTestMongoUrl(prefix);
  const moduleRef = await override(
    Test.createTestingModule({ imports: [AppModule] }),
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
