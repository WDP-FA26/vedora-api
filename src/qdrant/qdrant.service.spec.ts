import { ConfigService } from '@nestjs/config';
import { QdrantService } from './qdrant.service.js';

function build(): QdrantService {
  return new QdrantService(
    new ConfigService({ QDRANT_URL: 'http://localhost:6333' }),
  );
}

describe('QdrantService.onModuleInit', () => {
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

    await expect(qdrant.onModuleInit()).rejects.toThrow(
      'Qdrant at http://localhost:6333 is not reachable: ECONNREFUSED',
    );
  });
});
