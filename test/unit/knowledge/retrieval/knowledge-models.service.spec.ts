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

async function requestBody(call = 0): Promise<Record<string, unknown>> {
  const [input, init] = fetchMock.mock.calls[call];
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body) as Record<string, unknown>;
  }
  if (!(input instanceof Request)) throw new Error('Expected a JSON body');
  return (await input.clone().json()) as Record<string, unknown>;
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

  it('embeds images as Gemini multimodal parts, one request per batch of eight', async () => {
    ai.embedMany.mockImplementation(({ values }) =>
      Promise.resolve({
        embeddings: values.map((_, index) => [index]),
      } as never),
    );
    const image = { image: new Uint8Array([0xff, 0xd8]) };
    const inputs = ['đậu phụ', ...Array.from({ length: 8 }, () => image)];

    const vectors = await createService().embed(inputs);

    expect(vectors).toHaveLength(9);
    expect(ai.embedMany).toHaveBeenCalledTimes(2);
    const first = ai.embedMany.mock.calls[0][0];
    expect(first.values).toEqual(['đậu phụ', ...Array<string>(7).fill('')]);
    expect(first.providerOptions).toEqual({
      google: {
        content: [
          null,
          ...Array.from({ length: 7 }, () => [
            { inlineData: { mimeType: 'image/jpeg', data: '/9g=' } },
          ]),
        ],
      },
    });
    expect(ai.embedMany.mock.calls[1][0].values).toEqual(['']);
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
      await createService({ KNOWLEDGE_RERANK_ENABLED: false }).rerank(
        'q',
        ['a'],
        6,
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('ocrPdf', () => {
    async function pdfOf(...pages: string[]): Promise<Uint8Array> {
      const mupdf = await import('mupdf');
      const document = new mupdf.PDFDocument();
      const font = document.addSimpleFont(new mupdf.Font('Helvetica'));
      for (const text of pages) {
        const resources = document.addObject({ Font: { F1: font } });
        const page = document.addPage(
          [0, 0, 300, 200],
          0,
          resources,
          `BT /F1 12 Tf 20 150 Td (${text}) Tj ET`,
        );
        document.insertPage(-1, page);
      }
      return document.saveToBuffer('compress').asUint8Array();
    }

    function answer(text: string): Response {
      return Response.json({
        id: 'gen-ocr',
        model: 'mistralai/mistral-small-2603',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
      });
    }

    it('reads each page on its own with the OCR model, in page order', async () => {
      fetchMock
        .mockResolvedValueOnce(
          answer('```markdown\n# Trang 1\n![x](x.jpg)\nĐạm\n```'),
        )
        .mockResolvedValueOnce(answer('| Đậu | 8 |'));

      const pages = await createService().ocrPdf(
        await pdfOf('Page one', 'Page two'),
      );

      expect(pages).toEqual(['# Trang 1\n\nĐạm', '| Đậu | 8 |']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = await requestBody(0);
      expect(body.model).toBe('mistralai/mistral-small-2603');
      expect(JSON.stringify(body.messages)).toContain('application/pdf');
    });

    it('reports a failed page as an external service failure', async () => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { code: 402, message: 'Insufficient credits' } },
          { status: 402 },
        ),
      );

      await expect(
        createService().ocrPdf(await pdfOf('Page one')),
      ).rejects.toMatchObject({
        service: 'openrouter',
        reason: expect.stringMatching(/^OCR failed \(402\)/) as string,
      });
    });
  });

  it('returns an empty list immediately when embedding no inputs', async () => {
    await expect(createService().embed([])).resolves.toEqual([]);
    expect(ai.embedMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats document text with title and body', () => {
    expect(documentText('Đậu hũ', 'Giàu đạm thực vật')).toBe(
      'title: Đậu hũ | text: Giàu đạm thực vật',
    );
  });
});
