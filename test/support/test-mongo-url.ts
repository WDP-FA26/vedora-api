/**
 * Returns the MongoDB server URL used by the test suites to create disposable
 * per-spec databases. Populated by `test/support/global-setup.ts` (either from
 * an explicit `TEST_DATABASE_URL` env override or the ephemeral
 * `mongodb-memory-server` replica set).
 */
export function testMongoServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run tests via Vitest (globalSetup starts mongodb-memory-server) or set TEST_DATABASE_URL explicitly.',
    );
  }
  return url;
}
