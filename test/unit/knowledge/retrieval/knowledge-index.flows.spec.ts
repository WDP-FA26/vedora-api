import { ConfigService } from '@nestjs/config';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { QdrantService } from '@src/qdrant/qdrant.service.js';
import { KnowledgeIndexService } from '@src/knowledge/retrieval/knowledge-index.service.js';
import { KnowledgeModelsService } from '@src/knowledge/retrieval/knowledge-models.service.js';

/**
 * Chunking rules, black-box through what gets embedded and upserted:
 * every chunk carries the nearest heading above it exactly once (from its own
 * page, or carried over from earlier pages), blank pages add nothing, and
 * no text from a page is lost.
 */

const document = { id: 'doc-1', title: 'dinh-duong.pdf', runId: 'run-1' };
const PREFIX = 'title: dinh-duong.pdf | text: ';

function tableRows(count: number): string {
  const rows = ['| Thực phẩm | Canxi (mg) |', '| --- | --- |'];
  for (let row = 1; row <= count; row += 1) {
    rows.push(`| Thực phẩm số ${row} | ${row * 10} |`);
  }
  return rows.join('\n');
}

describe('KnowledgeIndexService chunking flows', () => {
  let client: DeepMockProxy<QdrantService>;
  let models: DeepMockProxy<KnowledgeModelsService>;
  let service: KnowledgeIndexService;

  const pagesOf = (texts: string[]) =>
    texts.map((text) => ({ text, images: [] }));

  /** The chunk texts sent for embedding, without the title prefix. */
  const embeddedChunks = async (texts: string[]): Promise<string[]> => {
    await service.index(document, pagesOf(texts));
    const textCall = models.embed.mock.calls.find(([inputs]) =>
      inputs.every((input) => typeof input === 'string'),
    );
    const inputs = textCall?.[0] ?? [];
    const chunks: string[] = [];
    for (const input of inputs) {
      if (typeof input !== 'string') continue;
      chunks.push(
        input.startsWith(PREFIX) ? input.slice(PREFIX.length) : input,
      );
    }
    return chunks;
  };

  const upsertedPayloads = () => {
    const payloads: Record<string, unknown>[] = [];
    for (const [, operation] of client.upsert.mock.calls) {
      if (!('points' in operation)) continue;
      for (const point of operation.points) {
        if (point.payload) payloads.push(point.payload);
      }
    }
    return payloads;
  };

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
      new ConfigService({ QDRANT_COLLECTION: 'flows_knowledge' }),
    );
  });

  describe('blank and heading-only pages', () => {
    it('embeds nothing for a whitespace-only page', async () => {
      const chunks = await embeddedChunks(['   \n\n \t \n']);

      expect(chunks).toEqual([]);
    });

    it('upserts no point for a document whose pages are all blank', async () => {
      await service.index(document, pagesOf(['', '  ']));

      expect(upsertedPayloads()).toEqual([]);
    });

    // Points of other runs are cleared by KnowledgeService once this run
    // finishes as the document's current one (removeOtherRuns).
    it("still clears this run's earlier points when a re-index has no chunks", async () => {
      await service.index(document, pagesOf(['']));

      expect(client.delete).toHaveBeenCalledWith(
        'flows_knowledge',
        expect.objectContaining({
          filter: {
            must: [
              { key: 'documentId', match: { value: 'doc-1' } },
              { key: 'runId', match: { value: 'run-1' } },
            ],
          },
        }),
      );
    });

    it('carries the heading across a blank page', async () => {
      const chunks = await embeddedChunks([
        '# Sắt\n\nĐậu lăng giàu sắt.',
        '',
        'Rau bina cũng giàu sắt.',
      ]);

      expect(chunks.at(-1)).toBe('Sắt\nRau bina cũng giàu sắt.');
    });

    it('labels the next page with a heading that sat alone on its page', async () => {
      const chunks = await embeddedChunks([
        '# Vitamin B12',
        'Rong biển chứa rất ít B12 có hoạt tính.',
      ]);

      expect(chunks.at(-1)).toBe(
        'Vitamin B12\nRong biển chứa rất ít B12 có hoạt tính.',
      );
    });

    it('never repeats a heading inside the same chunk', async () => {
      const chunks = await embeddedChunks(['# Canxi\n\nĐậu phụ giàu canxi.']);

      for (const chunk of chunks) {
        expect(chunk.split('Canxi').length - 1).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('tables', () => {
    it('splits a table larger than a chunk without losing any row', async () => {
      const table = tableRows(120);

      const chunks = await embeddedChunks([`# Bảng canxi\n\n${table}`]);

      expect(chunks.length).toBeGreaterThan(1);
      const joined = chunks.join('\n');
      for (let row = 1; row <= 120; row += 1) {
        expect(joined).toContain(`Thực phẩm số ${row} |`);
      }
    });

    it('gives every piece of a split table the heading above it', async () => {
      const chunks = await embeddedChunks([
        `# Bảng canxi\n\n${tableRows(120)}`,
      ]);

      const tablePieces = chunks.filter((chunk) => chunk.includes('|'));
      expect(tablePieces.length).toBeGreaterThan(1);
      for (const piece of tablePieces) {
        expect(piece.startsWith('Bảng canxi\n|')).toBe(true);
      }
    });

    it('labels a table that continues a previous page with that page heading', async () => {
      const chunks = await embeddedChunks([
        '# Bảng canxi\n\nSố liệu trên 100 g.',
        tableRows(5),
      ]);

      expect(chunks.at(-1)?.startsWith('Bảng canxi\n|')).toBe(true);
    });

    it('labels a table that OCR lifted above its heading with that heading', async () => {
      const chunks = await embeddedChunks([
        '# Sắt\n\nĐậu lăng.',
        `${tableRows(3)}\n\n# Kẽm\n\nHạt bí giàu kẽm.`,
      ]);

      const table = chunks.find((chunk) => chunk.includes('Thực phẩm số 1'));
      expect(table?.startsWith('Kẽm\n')).toBe(true);
    });
  });

  describe('heading detection', () => {
    it('keeps the previous heading for text that opens a page before a new heading', async () => {
      const chunks = await embeddedChunks([
        '# Sắt\n\nĐậu lăng giàu sắt.',
        'Rau bina cũng giàu sắt.\n\n# Kẽm\n\nHạt bí giàu kẽm.',
      ]);

      const opening = chunks.find((chunk) => chunk.includes('Rau bina'));
      expect(opening).toMatch(/^Sắt\n/);
    });

    // BUG-6: the carried-over heading uses a regex that disagrees with Markdown (code fences)
    it('does not treat a commented line inside a code block as a heading', async () => {
      const chunks = await embeddedChunks([
        '# Sắt\n\nĐậu lăng giàu sắt.',
        '```\n# not a heading\n```',
        'Rau bina cũng giàu sắt.',
      ]);

      expect(chunks.at(-1)).toBe('Sắt\nRau bina cũng giàu sắt.');
    });

    // BUG-6: the carried-over heading uses a regex that disagrees with Markdown (closing #)
    it('drops only the closing hashes of a heading, not a trailing # in its text', async () => {
      const chunks = await embeddedChunks([
        '# Ngôn ngữ C#\n\nĐoạn mở đầu.',
        'Trang sau.',
      ]);

      expect(chunks.at(-1)).toBe('Ngôn ngữ C#\nTrang sau.');
    });

    // BUG-6: the carried-over heading uses a regex that disagrees with Markdown (setext)
    it('carries a setext heading to the next page', async () => {
      const chunks = await embeddedChunks([
        'Canxi\n=====\n\nĐậu phụ giàu canxi.',
        'Rau cải xoăn cũng vậy.',
      ]);

      expect(chunks.at(-1)).toBe('Canxi\nRau cải xoăn cũng vậy.');
    });
  });

  describe('payloads', () => {
    it('numbers pages from 1 in the order given', async () => {
      await service.index(document, pagesOf(['Một.', 'Hai.', 'Ba.']));

      const pages = upsertedPayloads().map((payload) => payload.page);
      expect(pages).toEqual([1, 2, 3]);
    });

    it('stores the chunk text, heading included, as the payload text', async () => {
      await service.index(
        document,
        pagesOf(['# Sắt\n\nĐậu lăng.', 'Rau bina.']),
      );

      expect(upsertedPayloads().at(-1)).toMatchObject({
        documentId: 'doc-1',
        title: 'dinh-duong.pdf',
        kind: 'text',
        text: 'Sắt\nRau bina.',
      });
    });

    it('upserts in batches of at most 64 points', async () => {
      const longPages: string[] = [];
      for (let page = 0; page < 70; page += 1) longPages.push(`Trang ${page}.`);

      await service.index(document, pagesOf(longPages));

      const sizes = client.upsert.mock.calls.map(([, operation]) =>
        'points' in operation ? operation.points.length : 0,
      );
      expect(sizes).toEqual([64, 6]);
    });

    it('returns the number of page images it indexed', async () => {
      const jpeg = new Uint8Array([0xff, 0xd8]);

      const count = await service.index(document, [
        { text: 'Trang 1', images: [jpeg, jpeg] },
        { text: '', images: [jpeg] },
      ]);

      expect(count).toBe(3);
      const imagePages = upsertedPayloads()
        .filter((payload) => payload.kind === 'image')
        .map((payload) => payload.page);
      expect(imagePages).toEqual([1, 1, 2]);
    });
  });
});
