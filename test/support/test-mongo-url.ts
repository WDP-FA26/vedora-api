/**
 * The MongoDB server the test suites create their disposable databases on:
 * TEST_DATABASE_URL, or the RAM-backed `mongo-test` service from
 * docker-compose.yml (`docker compose up -d mongo-test`).
 */
const DEFAULT_TEST_MONGO_URL =
  'mongodb://localhost:27018/?directConnection=true';

export function testMongoServerUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_MONGO_URL;
}
