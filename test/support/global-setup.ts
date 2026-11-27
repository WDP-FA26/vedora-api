import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function setupTestMongo(): Promise<
  (() => Promise<void>) | void
> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    const url = new URL(externalUrl);
    const connection = mongoose.createConnection(url.toString(), {
      serverSelectionTimeoutMS: 3_000,
    });
    try {
      await connection.asPromise();
    } catch (error) {
      throw new Error(`Test MongoDB at ${url.host} is unreachable.`, {
        cause: error,
      });
    } finally {
      await connection.close();
    }
    return;
  }

  const replSet = await MongoMemoryReplSet.create({
    binary: {
      version: process.env.MONGOMS_VERSION ?? '8.0.4',
    },
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
    },
  });

  process.env.TEST_DATABASE_URL = replSet.getUri();

  return async () => {
    await replSet.stop();
  };
}
