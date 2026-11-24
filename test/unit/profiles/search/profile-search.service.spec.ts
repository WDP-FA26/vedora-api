import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { profileBm25 } from '@src/profiles/search/profile-search-collection.js';
import { QdrantService } from '@src/qdrant/qdrant.service.js';
import { ProfileSearchIndexService } from '@src/profiles/search/profile-search-index.service.js';
import { ProfileSearchService } from '@src/profiles/search/profile-search.service.js';

describe('ProfileSearchService', () => {
  let qdrant: DeepMockProxy<QdrantService>;
  let index: DeepMockProxy<ProfileSearchIndexService>;
  let service: ProfileSearchService;

  beforeEach(() => {
    qdrant = mockDeep<QdrantService>();
    index = mockDeep<ProfileSearchIndexService>();
    Object.defineProperty(index, 'collection', { value: 'test_profiles' });
    service = new ProfileSearchService(qdrant, index);
  });

  it('queries Qdrant BM25 identity, prefix, and bio vectors with weighted RRF and reports pagination', async () => {
    qdrant.query.mockResolvedValue({
      points: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
    } as never);

    const page = await service.search('@nguyen an', 10, 2);

    expect(page).toEqual({ ids: ['u1', 'u2'], hasMore: true });
    expect(qdrant.query).toHaveBeenCalledWith('test_profiles', {
      prefetch: [
        {
          query: profileBm25('nguyen an', false),
          using: 'identity_bm25',
          limit: 200,
        },
        {
          query: profileBm25('nguyen an', true),
          using: 'identity_bm25_folded',
          limit: 200,
        },
        {
          query: profileBm25('nguyen an', true),
          using: 'identity_prefix',
          limit: 200,
        },
        {
          query: profileBm25('nguyen an', false),
          using: 'bio_bm25',
          limit: 200,
        },
        {
          query: profileBm25('nguyen an', true),
          using: 'bio_bm25_folded',
          limit: 200,
        },
      ],
      query: { rrf: { weights: [4, 3, 2, 1, 1] } },
      offset: 10,
      limit: 3,
      with_payload: false,
    });
  });

  it('returns empty results without hitting Qdrant when query only contains @ symbols', async () => {
    await expect(service.search('@@@', 0, 20)).resolves.toEqual({
      ids: [],
      hasMore: false,
    });
    expect(qdrant.query).not.toHaveBeenCalled();
  });

  it('reports hasMore false when fewer points than limit+1 are returned', async () => {
    qdrant.query.mockResolvedValue({ points: [{ id: 'u1' }] } as never);

    await expect(service.search('minh', 0, 2)).resolves.toEqual({
      ids: ['u1'],
      hasMore: false,
    });
  });

  it('prunes stale user ids through the profile search index', async () => {
    index.removeMany.mockResolvedValue();

    await expect(service.prune(['u1', 'u2'])).resolves.toBeUndefined();
    expect(index.removeMany).toHaveBeenCalledWith(['u1', 'u2']);
  });
});
