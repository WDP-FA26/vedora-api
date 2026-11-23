import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { mockDeep } from 'vitest-mock-extended';
import { AiCostTransportService } from '../../../src/ai/telemetry/ai-cost-transport.service.js';
import { TranscriptionService } from '../../../src/media/captions/transcription.service.js';
import { KnowledgeModelsService } from '../../../src/knowledge/retrieval/knowledge-models.service.js';
import { KnowledgeSearchService } from '../../../src/knowledge/retrieval/knowledge-search.service.js';
import { KnowledgeIndexService } from '../../../src/knowledge/retrieval/knowledge-index.service.js';
import { PostSearchService } from '../../../src/posts/search/post-search.service.js';
import { PostSearchIndexService } from '../../../src/posts/search/post-search-index.service.js';
import { MenuSearchService } from '../../../src/workspaces/search/menu-search.service.js';
import { MenuSearchIndexService } from '../../../src/workspaces/search/menu-search-index.service.js';
import { QdrantService } from '../../../src/qdrant/qdrant.service.js';

describe('OpenAI mode integrations', () => {
  const config = () =>
    new ConfigService({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'fixture-direct',
    });

  it('transcribes using multipart audio with word timestamps and keeps timeline conversion', async () => {
    const ai = mockDeep<AiService>(),
      costs = mockDeep<AiCostTransportService>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'Tofu soup',
          language: 'english',
          words: [
            { word: 'Tofu', start: 0, end: 1 },
            { word: 'soup', start: 1, end: 2 },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    costs.forProvider.mockReturnValue(fetchMock);
    const service = new TranscriptionService(config(), ai, costs);
    const result = await service.transcribe({
      audio: Buffer.from('fixture-mp3'),
      speech: [{ start: 4, end: 6 }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer fixture-direct',
    );
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error('Expected multipart');
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('response_format')).toBe('verbose_json');
    expect(body.get('timestamp_granularities[]')).toBe('word');
    const file = body.get('file');
    if (!(file instanceof Blob)) throw new Error('Expected audio');
    expect(await file.text()).toBe('fixture-mp3');
    expect(result.language).toBe('en');
    expect(result.cues[0].start).toBe(4);
    expect(result.cues.at(-1)?.end).toBe(6);
    expect(costs.fetch).not.toHaveBeenCalled();
  });

  it('uses the selected native chat model for PDF text extraction and skips OpenRouter rerank', async () => {
    const ai = mockDeep<AiService>(),
      costs = mockDeep<AiCostTransportService>();
    ai.generateObject.mockResolvedValue({
      object: { pages: ['page one', 'page two'] },
    } as never);
    const service = new KnowledgeModelsService(config(), ai, costs);
    expect(service.sparseOnly).toBe(true);
    await expect(service.ocrPdf(Uint8Array.from([1, 2, 3]))).resolves.toEqual([
      'page one',
      'page two',
    ]);
    expect(ai.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'ocr-knowledge',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: Uint8Array.from([1, 2, 3]),
                mediaType: 'application/pdf',
              },
            ],
          },
        ],
      }),
    );
    await expect(
      service.rerank('tofu', ['tofu'], 1, new AbortController().signal),
    ).resolves.toBeNull();
    await expect(
      service.embed([{ image: Uint8Array.from([1]) }]),
    ).rejects.toThrow(/cannot embed images/);
    expect(costs.fetch).not.toHaveBeenCalled();
  });

  it('searches saved knowledge by BM25 without issuing or mixing dense embeddings', async () => {
    const models = mockDeep<KnowledgeModelsService>(),
      qdrant = mockDeep<QdrantService>();
    Object.defineProperty(models, 'sparseOnly', { value: true });
    models.rerank.mockResolvedValue(null);
    qdrant.query.mockResolvedValue({
      points: [
        {
          id: 'point',
          payload: {
            documentId: 'document',
            title: 'Tofu',
            page: 1,
            kind: 'text',
            text: 'Tofu soup',
          },
        },
      ],
    } as never);
    const service = new KnowledgeSearchService(qdrant, models, {
      collection: 'existing-gemini-knowledge',
    } as KnowledgeIndexService);
    await expect(service.search('tofu')).resolves.toEqual([
      { title: 'Tofu', page: 1, text: 'Tofu soup' },
    ]);
    expect(models.embedQuery).not.toHaveBeenCalled();
    expect(qdrant.query).toHaveBeenCalledWith(
      'existing-gemini-knowledge',
      expect.objectContaining({
        prefetch: [
          expect.objectContaining({ using: 'bm25' }),
          expect.objectContaining({ using: 'bm25_folded' }),
        ],
      }),
    );
  });

  it.each(['posts', 'menu'] as const)(
    'searches %s with existing sparse indexes without an OpenRouter dependency',
    async (kind) => {
      const ai = mockDeep<AiService>(),
        qdrant = mockDeep<QdrantService>();
      qdrant.query.mockResolvedValue({
        points: [{ id: 'fixture-match' }],
      } as never);
      const postIndex = mockDeep<PostSearchIndexService>(),
        menuIndex = mockDeep<MenuSearchIndexService>();
      Object.defineProperty(postIndex, 'sparseOnly', { value: true });
      Object.defineProperty(postIndex, 'collection', {
        value: 'existing-posts',
      });
      Object.defineProperty(menuIndex, 'sparseOnly', { value: true });
      Object.defineProperty(menuIndex, 'collection', {
        value: 'existing-menu',
      });
      const service =
        kind === 'posts'
          ? new PostSearchService(qdrant, ai, postIndex, config())
          : new MenuSearchService(qdrant, ai, menuIndex, config());
      await expect(service.search('tofu', 0, 10)).resolves.toEqual({
        ids: ['fixture-match'],
        hasMore: false,
      });
      expect(ai.embed).not.toHaveBeenCalled();
      expect(qdrant.query).toHaveBeenCalledWith(
        kind === 'posts' ? 'existing-posts' : 'existing-menu',
        expect.objectContaining({
          prefetch: [
            expect.objectContaining({ using: 'bm25' }),
            expect.objectContaining({ using: 'bm25_folded' }),
          ],
        }),
      );
    },
  );
});
