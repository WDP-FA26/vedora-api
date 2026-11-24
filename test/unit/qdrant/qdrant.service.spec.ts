import { ConfigService } from '@nestjs/config';
import { QdrantService } from '@src/qdrant/qdrant.service.js';

function build(overrides: Record<string, string> = {}): QdrantService {
  return new QdrantService(
    new ConfigService({ QDRANT_URL: 'http://localhost:6333', ...overrides }),
  );
}

describe('QdrantService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts an optional QDRANT_API_KEY configuration', async () => {
    const qdrant = build({ QDRANT_API_KEY: 'secret-qdrant-key' });
    vi.spyOn(qdrant, 'getCollections').mockResolvedValue({ collections: [] });

    await expect(qdrant.onModuleInit()).resolves.toBeUndefined();
  });

  it('starts when Qdrant answers', async () => {
    const qdrant = build();
    vi.spyOn(qdrant, 'getCollections').mockResolvedValue({ collections: [] });

    await expect(qdrant.onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start when Qdrant is unreachable', async () => {
    const qdrant = build();
    vi.spyOn(qdrant, 'getCollections').mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    await expect(qdrant.onModuleInit()).rejects.toMatchObject({
      message: 'qdrant request failed',
      reason: 'Qdrant at http://localhost:6333 is not reachable: ECONNREFUSED',
    });
  });

  it('includes error cause message when Qdrant fails with a nested cause', async () => {
    const qdrant = build();
    vi.spyOn(qdrant, 'getCollections').mockRejectedValue(
      new Error('fetch failed', { cause: new Error('ECONNRESET') }),
    );

    await expect(qdrant.onModuleInit()).rejects.toMatchObject({
      message: 'qdrant request failed',
      reason:
        'Qdrant at http://localhost:6333 is not reachable: fetch failed (ECONNRESET)',
    });
  });

  it('stringifies non-Error rejections during startup probe', async () => {
    const qdrant = build();
    vi.spyOn(qdrant, 'getCollections').mockRejectedValue('socket closed');

    await expect(qdrant.onModuleInit()).rejects.toMatchObject({
      message: 'qdrant request failed',
      reason: 'Qdrant at http://localhost:6333 is not reachable: socket closed',
    });
  });

  it('times out if Qdrant does not answer within the startup budget', async () => {
    vi.useFakeTimers();
    const qdrant = build();
    vi.spyOn(qdrant, 'getCollections').mockReturnValue(new Promise(() => {}));

    let rejection: unknown;
    const init = qdrant.onModuleInit().catch((error: unknown) => {
      rejection = error;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await init;
    expect(rejection).toMatchObject({
      message: 'qdrant request failed',
      reason:
        'Qdrant at http://localhost:6333 is not reachable: no answer within 5s',
    });
  });
});
