export function testMongoServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run tests via Vitest (globalSetup starts mongodb-memory-server) or set TEST_DATABASE_URL explicitly.',
    );
  }
  return url;
}
