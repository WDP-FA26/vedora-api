import mongoose from 'mongoose';
import { testMongoServerUrl } from './test-mongo-url.js';

/**
 * Fails the run once, up front, when the test MongoDB is down; otherwise every
 * spec would wait out its own server-selection timeout.
 */
export default async function checkTestMongo(): Promise<void> {
  const url = new URL(testMongoServerUrl());
  const connection = mongoose.createConnection(url.toString(), {
    serverSelectionTimeoutMS: 3_000,
  });
  try {
    await connection.asPromise();
  } catch (error) {
    throw new Error(
      `Test MongoDB at ${url.host} is unreachable. Start it with ` +
        '`docker compose up -d mongo-test` or set TEST_DATABASE_URL.',
      { cause: error },
    );
  } finally {
    await connection.close();
  }
}
