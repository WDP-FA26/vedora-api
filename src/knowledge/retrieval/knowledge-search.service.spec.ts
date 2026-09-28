import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { QdrantService } from '../../qdrant/qdrant.service';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeModelsService } from './knowledge-models.service';
import { KnowledgeSearchService } from './knowledge-search.service';

const point = (kind: string, page: number, text: string) => ({
  id: `${kind}-${page}-${text}`,
  version: 1,
  score: 0.5,
  payload: { documentId: 'doc-1', title: 'dinh-duong.pdf', page, kind, text },
});

describe('KnowledgeSearchService', () => {
  let client: DeepMockProxy<QdrantService>;
  let models: DeepMockProxy<KnowledgeModelsService>;
  let service: KnowledgeSearchService;

  beforeEach(() => {
    client = mockDeep<QdrantService>();
    models = mockDeep<KnowledgeModelsService>();
    models.embedQuery.mockResolvedValue([0.1, 0.2]);
    const index = mockDeep<KnowledgeIndexService>();
    Object.defineProperty(index, 'collection', { value: 'test_knowledge' });
    service = new KnowledgeSearchService(client, models, index);
    client.query.mockResolvedValue({
      points: [
        point('text', 1, 'Đậu phụ 350 mg canxi'),
        point('image', 3, 'Trang 3'),
        point('image', 3, 'Trang 3'),
        point('text', 2, 'Xe máy cần thay nhớt'),
      ],
    });
  });

  it('fuses dense, exact and accent-folded BM25 results', async () => {
    models.rerank.mockResolvedValue(null);

    await service.search('dau phu canxi');

    expect(client.query).toHaveBeenCalledWith('test_knowledge', {
      prefetch: [
        expect.objectContaining({ using: 'dense', limit: 40 }),
        expect.objectContaining({ using: 'bm25', limit: 40 }),
        expect.objectContaining({ using: 'bm25_folded', limit: 40 }),
      ],
      query: { fusion: 'rrf' },
      limit: 20,
      with_payload: true,
    });
  });

  it('keeps reranked passages above the relevance bar, best first', async () => {
    models.rerank.mockResolvedValue([
      { index: 1, relevanceScore: 0.8 },
      { index: 0, relevanceScore: 0.6 },
      { index: 2, relevanceScore: 0.02 },
    ]);

    const hits = await service.search('Đậu phụ có bao nhiêu canxi?');

    const [, documents] = models.rerank.mock.calls[0];
    expect(documents).toEqual([
      'dinh-duong.pdf\nĐậu phụ 350 mg canxi',
      'dinh-duong.pdf\nTrang 3',
      'dinh-duong.pdf\nXe máy cần thay nhớt',
    ]);
    expect(hits).toEqual([
      { title: 'dinh-duong.pdf', page: 3, text: 'Trang 3' },
      { title: 'dinh-duong.pdf', page: 1, text: 'Đậu phụ 350 mg canxi' },
    ]);
  });

  it('keeps the fused order without a reranker', async () => {
    models.rerank.mockResolvedValue(null);

    const hits = await service.search('canxi');

    expect(hits.map(({ page }) => page)).toEqual([1, 3, 2]);
  });

  it('falls back to the fused order when reranking fails', async () => {
    models.rerank.mockRejectedValue(new Error('timeout'));

    const hits = await service.search('canxi');

    expect(hits.map(({ page }) => page)).toEqual([1, 3, 2]);
  });

  it('gives up when the caller aborts', async () => {
    const controller = new AbortController();
    models.rerank.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });

    await expect(service.search('canxi', controller.signal)).rejects.toThrow(
      'aborted',
    );
  });
});
