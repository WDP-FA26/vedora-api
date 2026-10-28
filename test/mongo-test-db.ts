import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MODEL_DEFINITIONS } from '../src/mongo/schemas/index.js';

/** The local replica set from docker-compose.yml, unless TEST_DATABASE_URL is set. */
const LOCAL_TEST_URL =
  'mongodb://vedora:vedora_local_password@localhost:27017/?authSource=admin&directConnection=true';

/**
 * A disposable MongoDB database, one per spec, so files can run in parallel
 * without sharing data.
 */
export function createTestMongoUrl(prefix: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_TEST_URL);
  url.pathname = `/${prefix}_${randomUUID().replaceAll('-', '')}`;
  return url.toString();
}

/**
 * Awaits the index builds the schemas declare, so unique constraints are in
 * place before a spec writes anything.
 */
export async function prepareTestDatabase(
  app: INestApplication,
): Promise<Connection> {
  const connection = app.get<Connection>(getConnectionToken());
  await Promise.all(
    MODEL_DEFINITIONS.map(({ name }) => connection.model(name).init()),
  );
  return connection;
}

/** Drops the disposable database, before the app closes its connection. */
export async function dropTestDatabase(app: INestApplication): Promise<void> {
  const connection = app.get<Connection>(getConnectionToken());
  await connection.dropDatabase();
}
