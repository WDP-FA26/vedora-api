import { ConfigService } from '@nestjs/config';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import { KnowledgeIndexService } from './knowledge-index.service.js';
import { KnowledgeModelsService } from './knowledge-models.service.js';

const document = { id: 'doc-1', title: 'dinh-duong.pdf' };

describe('KnowledgeIndexService', () => {
  let client: DeepMockProxy<QdrantService>;
  let models: DeepMockProxy<KnowledgeModelsService>;
  let service: KnowledgeIndexService;

  beforeEach(() => {
    client = mockDeep<QdrantService>();
    models = mockDeep<KnowledgeModelsService>();
    Object.defineProperty(models, 'dimensions', { value: 4 });
    models.embed.mockImplementation((inputs) =>
      Promise.resolve(inputs.map(() => [0.1, 0.2, 0.3, 0.4])),
    );
    client.collectionExists.mockResolvedValue({ exists: false });
    service = new KnowledgeIndexService(
      client,
      models,
      new ConfigService({ QDRANT_COLLECTION: 'test_knowledge' }),
    );
  });

  it('creates the collection with dense and both BM25 vectors once', async () => {
    await service.index(document, []);
    await service.index(document, []);

    expect(client.createCollection).toHaveBeenCalledExactlyOnceWith(
      'test_knowledge',
      {
        vectors: { dense: { size: 4, distance: 'Cosine', on_disk: true } },
        sparse_vectors: {
          bm25: { modifier: 'idf' },
          bm25_folded: { modifier: 'idf' },
        },
        quantization_config: { scalar: { type: 'int8', always_ram: true } },
      },
    );
    expect(client.createPayloadIndex).toHaveBeenCalledWith(
      'test_knowledge',
      expect.objectContaining({ field_name: 'documentId' }),
    );
  });

  it('refuses a collection built for another embedding size', async () => {
    client.collectionExists.mockResolvedValue({ exists: true });
    client.getCollection.mockResolvedValue({
      config: { params: { vectors: { dense: { size: 3072 } } } },
    } as never);

    await expect(service.index(document, [])).rejects.toThrow(
      'does not hold 4-dimension',
    );
  });

  it('replaces the document with its chunks and images', async () => {
    const image = new Uint8Array([0xff, 0xd8]);

    const imageCount = await service.index(document, [
      { text: '# Canxi\n\nĐậu phụ giàu canxi.', images: [image] },
      { text: '', images: [] },
    ]);

    expect(imageCount).toBe(1);
    expect(models.embed).toHaveBeenCalledWith([
      'title: dinh-duong.pdf | text: # Canxi\n\nĐậu phụ giàu canxi.',
    ]);
    expect(models.embed).toHaveBeenCalledWith([{ image }]);
    expect(client.delete.mock.invocationCallOrder[0]).toBeLessThan(
      client.upsert.mock.invocationCallOrder[0],
    );
    const operation = client.upsert.mock.calls[0][1];
    if (!('points' in operation)) throw new Error('expected points');
    const { points } = operation;
    expect(points).toHaveLength(2);
    expect(Object.keys(points[0].vector)).toEqual([
      'dense',
      'bm25',
      'bm25_folded',
    ]);
    expect(points[0].payload).toEqual({
      documentId: 'doc-1',
      title: 'dinh-duong.pdf',
      page: 1,
      kind: 'text',
      text: '# Canxi\n\nĐậu phụ giàu canxi.',
    });
    expect(Object.keys(points[1].vector)).toEqual(['dense']);
    expect(points[1].payload).toMatchObject({ kind: 'image', page: 1 });
  });

  it('carries heading breadcrumbs into chunks split under them', async () => {
    const paragraph = 'Đậu phụ giàu canxi và đạm. '.repeat(60);

    await service.index(document, [
      { text: `# Canxi\n\n${paragraph}\n\n${paragraph}`, images: [] },
    ]);

    const [texts] = models.embed.mock.calls[0] as [string[]];
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.at(-1)).toMatch(/^title: dinh-duong\.pdf \| text: Canxi\n/);
  });
});
