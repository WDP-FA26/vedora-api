import { ConfigService } from '@nestjs/config';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { QdrantService } from '../../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import { PostSearchIndexService } from './post-search-index.service';
import { PostSearchService } from './post-search.service';

describe('PostSearchService', () => {
  let qdrant: DeepMockProxy<QdrantService>;
  let embeddings: DeepMockProxy<PostEmbeddingsService>;
  let index: DeepMockProxy<PostSearchIndexService>;
  let service: PostSearchService;

  beforeEach(() => {
    qdrant = mockDeep<QdrantService>();
    embeddings = mockDeep<PostEmbeddingsService>();
    index = mockDeep<PostSearchIndexService>();
    Object.defineProperty(index, 'collection', { value: 'test_posts' });
    embeddings.embedQuery.mockResolvedValue([0.1, 0.2]);
    service = new PostSearchService(
      qdrant,
      embeddings,
      index,
      new ConfigService({ POST_SEARCH_MIN_SCORE: 0.7 }),
    );
  });

  it('fuses meaning and keyword matches and reports a further page', async () => {
    qdrant.query.mockResolvedValue({
      points: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    } as never);

    const page = await service.search('dau hu', 20, 2);

    expect(page).toEqual({ ids: ['a', 'b'], hasMore: true });
    expect(qdrant.query).toHaveBeenCalledWith('test_posts', {
      prefetch: [
        {
          query: [0.1, 0.2],
          using: 'dense',
          limit: 200,
          score_threshold: 0.7,
        },
        expect.objectContaining({ using: 'bm25' }),
        expect.objectContaining({ using: 'bm25_folded' }),
      ],
      query: { fusion: 'rrf' },
      offset: 20,
      limit: 3,
      with_payload: false,
    });
  });

  it('has no further page when fewer points come back', async () => {
    qdrant.query.mockResolvedValue({ points: [{ id: 'a' }] } as never);

    await expect(service.search('phở', 0, 2)).resolves.toEqual({
      ids: ['a'],
      hasMore: false,
    });
  });
});
