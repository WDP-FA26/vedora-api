import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MODEL_DEFINITIONS } from '../../src/mongo/schemas/model-definitions.js';

const LOCAL_TEST_URL =
  'mongodb://vedora:vedora_local_password@localhost:27017/?authSource=admin&directConnection=true';

export function createTestMongoUrl(prefix: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_TEST_URL);
  url.pathname = `/${prefix}_${randomUUID().replaceAll('-', '')}`;
  return url.toString();
}

export async function prepareTestDatabase(
  app: INestApplication,
): Promise<Connection> {
  const connection = app.get<Connection>(getConnectionToken());
  await Promise.all(
    MODEL_DEFINITIONS.map(({ name }) => connection.model(name).init()),
  );
  return connection;
}

export async function dropTestDatabase(app: INestApplication): Promise<void> {
  const connection = app.get<Connection>(getConnectionToken());
  await connection.dropDatabase();
}
