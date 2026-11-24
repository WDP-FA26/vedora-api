import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { mockDeep } from 'vitest-mock-extended';
import {
  documentText,
  KnowledgeModelsService,
} from '@src/knowledge/retrieval/knowledge-models.service.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';

const fetchMock = vi.fn<typeof fetch>();
let ai = mockDeep<AiService>();

function createService(config: Record<string, unknown> = {}) {
  return new KnowledgeModelsService(
    new ConfigService({ OPENROUTER_API_KEY: 'key', ...config }),
    ai,
    Object.assign(mockDeep<AiCostTransportService>(), { fetch: fetchMock }),
  );
}

/** The JSON the call put on the wire, from a raw fetch or an SDK `Request`. */
async function requestBody(call = 0): Promise<Record<string, unknown>> {
  const [input, init] = fetchMock.mock.calls[call];
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body) as Record<string, unknown>;
  }
  if (!(input instanceof Request)) throw new Error('Expected a JSON body');
  return (await input.clone().json()) as Record<string, unknown>;
}

function requestUrl(call = 0): string {
  const [input] = fetchMock.mock.calls[call];
  if (typeof input === 'string') return input;
  return input instanceof Request ? input.url : input.toString();
}

describe('KnowledgeModelsService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    ai = mockDeep<AiService>();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('embeds text chunks and queries through AiService', async () => {
    ai.embedMany.mockResolvedValue({ embeddings: [[1], [2]] } as never);
    ai.embed.mockResolvedValue({ embedding: [3] } as never);
    const signal = new AbortController().signal;
    const service = createService();

    await expect(service.embed(['đậu phụ', 'canxi'])).resolves.toEqual([
      [1],
      [2],
    ]);
    await expect(service.embedQuery('đậu phụ', signal)).resolves.toEqual([3]);

    expect(ai.embedMany).toHaveBeenCalledWith({
      label: 'index-knowledge',
      values: ['đậu phụ', 'canxi'],
    });
    expect(ai.embed).toHaveBeenCalledWith({
      label: 'search-knowledge',
      value: 'task: question answering | query: đậu phụ',
      abortSignal: signal,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embeds multimodal inputs at the configured size, in input order', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        object: 'list',
        model: 'google/gemini-embedding-2',
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
    expect(requestUrl()).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(await requestBody()).toEqual({
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

  it('keeps OpenRouter error details out of the public message', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: 402, message: 'Insufficient credits' } },
        { status: 402 },
      ),
    );

    await expect(
      createService().embed([{ image: new Uint8Array([0xff, 0xd8]) }]),
    ).rejects.toMatchObject({
      message: 'openrouter request failed',
      reason: 'Embeddings failed (402): Insufficient credits',
    });
  });

  it('reranks best first', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        model: 'cohere/rerank-v3.5',
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
    expect(await requestBody()).toEqual({
      model: 'cohere/rerank-v3.5',
      query: 'q',
      documents: ['a', 'b'],
      top_n: 6,
    });
  });

  it('gives up when its signal aborts', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          // The SDK reaches fetch asynchronously, so the signal may already be aborted.
          if (signal?.aborted) reject(new Error('aborted'));
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const controller = new AbortController();

    const reranking = createService({
      OPENROUTER_RERANK_MODEL: 'cohere/rerank-v3.5',
    }).rerank('q', ['a'], 6, controller.signal);
    controller.abort();

    await expect(reranking).rejects.toMatchObject({
      reason: expect.stringContaining('aborted') as string,
    });
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
      expect(await requestBody()).toMatchObject({
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
          { error: { code: 402, message: 'Insufficient credits' } },
          { status: 402 },
        ),
      );

      await expect(
        createService().ocrPdf(new Uint8Array([1])),
      ).rejects.toMatchObject({
        message: 'openrouter request failed',
        reason: 'OCR returned no parse (402): Insufficient credits',
      });
    });

    it('falls back to "no annotations" when neither annotations nor error message exist', async () => {
      fetchMock.mockResolvedValue(Response.json({}, { status: 200 }));

      await expect(
        createService().ocrPdf(new Uint8Array([1])),
      ).rejects.toMatchObject({
        message: 'openrouter request failed',
        reason: 'OCR returned no parse (200): no annotations',
      });
    });
  });

  it('returns an empty list immediately when embedding no inputs', async () => {
    await expect(createService().embed([])).resolves.toEqual([]);
    expect(ai.embedMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects stream responses from multimodal embeddings and rerank', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await expect(
      createService().embed([{ image: new Uint8Array([1]) }]),
    ).rejects.toMatchObject({
      message: 'openrouter request failed',
      reason: 'Embeddings returned a stream instead of vectors',
    });

    fetchMock.mockResolvedValueOnce(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await expect(
      createService({
        OPENROUTER_RERANK_MODEL: 'cohere/rerank-v3.5',
      }).rerank('q', ['a'], 1, new AbortController().signal),
    ).rejects.toMatchObject({
      message: 'openrouter request failed',
      reason: 'Rerank returned a stream instead of results',
    });
  });

  it('rejects base64 embeddings and falls back to position when index is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        object: 'list',
        model: 'google/gemini-embedding-2',
        data: [{ object: 'embedding', index: 0, embedding: 'AAAA' }],
      }),
    );
    await expect(
      createService().embed([{ image: new Uint8Array([1]) }]),
    ).rejects.toMatchObject({
      message: 'openrouter request failed',
      reason: 'Embeddings returned base64 although floats were requested',
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        object: 'list',
        model: 'google/gemini-embedding-2',
        data: [
          { object: 'embedding', embedding: [0.4] },
          { object: 'embedding', embedding: [0.5] },
        ],
      }),
    );
    await expect(
      createService().embed([
        { image: new Uint8Array([1]) },
        { image: new Uint8Array([2]) },
      ]),
    ).resolves.toEqual([[0.4], [0.5]]);
  });

  it('formats document text with title and body', () => {
    expect(documentText('Đậu hũ', 'Giàu đạm thực vật')).toBe(
      'title: Đậu hũ | text: Giàu đạm thực vật',
    );
  });
});
