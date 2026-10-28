import { ConfigService } from '@nestjs/config';
import { KnowledgeModelsService } from './knowledge-models.service.js';

const fetchMock = vi.fn<typeof fetch>();

function createService(config: Record<string, unknown> = {}) {
  return new KnowledgeModelsService(
    new ConfigService({ OPENROUTER_API_KEY: 'key', ...config }),
  );
}

function requestBody(call = 0) {
  const [, init] = fetchMock.mock.calls[call];
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON string body');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('KnowledgeModelsService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('embeds text and images at the configured size, in input order', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { object: 'embedding', index: 1, embedding: [2] },
          { object: 'embedding', index: 0, embedding: [1] },
        ],
      }),
    );

    const vectors = await createService({
      KNOWLEDGE_EMBEDDING_DIMENSIONS: 768,
    }).embed(['đậu phụ', { image: new Uint8Array([0xff, 0xd8]) }]);

    expect(vectors).toEqual([[1], [2]]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/embeddings',
    );
    expect(requestBody()).toEqual({
      model: 'google/gemini-embedding-2',
      dimensions: 768,
      encoding_format: 'float',
      input: [
        { content: [{ type: 'text', text: 'đậu phụ' }] },
        {
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,/9g=' },
            },
          ],
        },
      ],
    });
  });

  it('reports OpenRouter errors with their message', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { message: 'Insufficient credits' } },
        { status: 402 },
      ),
    );

    await expect(createService().embedQuery('q')).rejects.toThrow(
      'OpenRouter /embeddings failed (402): Insufficient credits',
    );
  });

  it('reranks best first', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        results: [
          { index: 1, relevance_score: 0.9, document: { text: 'b' } },
          { index: 0, relevance_score: 0.1, document: { text: 'a' } },
        ],
      }),
    );

    const results = await createService({
      OPENROUTER_RERANK_MODEL: 'cohere/rerank-v3.5',
    }).rerank('q', ['a', 'b'], 6, new AbortController().signal);

    expect(results).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.1 },
    ]);
    expect(requestBody()).toEqual({
      model: 'cohere/rerank-v3.5',
      query: 'q',
      documents: ['a', 'b'],
      top_n: 6,
    });
  });

  it('gives up when its signal aborts', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const controller = new AbortController();

    const reranking = createService({
      OPENROUTER_RERANK_MODEL: 'cohere/rerank-v3.5',
    }).rerank('q', ['a'], 6, controller.signal);
    controller.abort();

    await expect(reranking).rejects.toThrow('aborted');
  });

  it('skips reranking without a rerank model', async () => {
    expect(
      await createService().rerank('q', ['a'], 6, new AbortController().signal),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('ocrPdf', () => {
    type ParsedPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };
    const parse = (content: ParsedPart[]) => [
      { type: 'file', file: { hash: 'h', content } },
    ];

    it('returns the Markdown of each page from the file annotation', async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                annotations: parse([
                  { type: 'text', text: '<file name="document.pdf">' },
                  {
                    type: 'text',
                    text: '# Trang 1\n\n![img-0.jpeg](img-0.jpeg)\n\nĐạm',
                  },
                  {
                    type: 'image_url',
                    image_url: { url: 'data:image/jpeg;base64,x' },
                  },
                  { type: 'text', text: '| Đậu | 8 |' },
                  { type: 'text', text: '</file>' },
                ]),
              },
            },
          ],
        }),
      );

      const pages = await createService().ocrPdf(new Uint8Array([1]));

      expect(pages).toEqual(['# Trang 1\n\n\n\nĐạm', '| Đậu | 8 |']);
      expect(requestBody()).toMatchObject({
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      });
    });

    it('uses the parse even when the carrier model failed', async () => {
      fetchMock.mockResolvedValue(
        Response.json(
          {
            error: {
              message: 'Provider returned error',
              metadata: {
                file_annotations: parse([{ type: 'text', text: 'Trang 1' }]),
              },
            },
          },
          { status: 502 },
        ),
      );

      expect(await createService().ocrPdf(new Uint8Array([1]))).toEqual([
        'Trang 1',
      ]);
    });

    it('throws when OpenRouter returns no parse', async () => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { message: 'Insufficient credits' } },
          { status: 402 },
        ),
      );

      await expect(createService().ocrPdf(new Uint8Array([1]))).rejects.toThrow(
        'OCR returned no parse (402): Insufficient credits',
      );
    });
  });
});
