import { KnowledgeDocumentFailureReason } from '../../mongo/models.js';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { KnowledgeModelsService } from '../retrieval/knowledge-models.service.js';
import { DocumentExtractionError } from './document-extractor.js';
import { PdfExtractor } from './pdf-extractor.js';

type Page = { text?: string; image?: boolean };

/** MuPDF repairs the missing xref table. */
function pdfWithPages(...pages: Page[]): Uint8Array {
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const pixels = 'A'.repeat(120 * 120 * 3);
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>endobj`,
    ...pages.flatMap(({ text, image }, index) => {
      const id = pageIds[index];
      const stream = [
        text ? `BT /F1 18 Tf 20 200 Td (${text}) Tj ET` : '',
        image ? 'q 100 0 0 100 20 20 cm /Im1 Do Q' : '',
      ].join('\n');
      return [
        `${id} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 240]/Contents ${id + 1} 0 R/Resources<</Font<</F1 99 0 R>>/XObject<</Im1 98 0 R>>>>>>endobj`,
        `${id + 1} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
      ];
    }),
    `98 0 obj<</Type/XObject/Subtype/Image/Width 120/Height 120/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ${pixels.length}>>stream\n${pixels}\nendstream endobj`,
    '99 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  return new TextEncoder().encode(
    `%PDF-1.4\n${objects.join('\n')}\ntrailer<</Root 1 0 R>>\n%%EOF`,
  );
}

async function darkestPixel(pdf: Uint8Array): Promise<number> {
  const mupdf = await import('mupdf');
  const document = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pixmap = document
    .loadPage(0)
    .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
  return Math.min(...pixmap.getPixels());
}

describe('PdfExtractor', () => {
  let models: DeepMockProxy<KnowledgeModelsService>;
  let extractor: PdfExtractor;

  beforeEach(() => {
    models = mockDeep<KnowledgeModelsService>();
    extractor = new PdfExtractor(models);
  });

  async function failureOf(file: Uint8Array) {
    try {
      await extractor.extract(file);
    } catch (error) {
      if (error instanceof DocumentExtractionError) return error.reason;
      throw error;
    }
    throw new Error('expected the extraction to fail');
  }

  it('pairs OCR text with the images MuPDF takes out of each page', async () => {
    models.ocrPdf.mockResolvedValue(['# Trang 1', '| Dau phu | 8g |']);

    const sections = await extractor.extract(
      pdfWithPages({ image: true }, { text: 'Dau phu 8g' }),
    );

    expect(sections).toEqual([
      { text: '# Trang 1', images: [expect.any(Uint8Array)] },
      { text: '| Dau phu | 8g |', images: [] },
    ]);
    expect([...sections[0].images[0].slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('blanks the images in the copy it sends to OCR', async () => {
    models.ocrPdf.mockResolvedValue(['']);
    const file = pdfWithPages({ image: true });
    expect(await darkestPixel(file)).toBeLessThan(255);

    await extractor.extract(file);

    expect(await darkestPixel(models.ocrPdf.mock.calls[0][0])).toBe(255);
  });

  it('keeps extra OCR pages on the last page', async () => {
    models.ocrPdf.mockResolvedValue(['a', 'b', 'c']);

    const sections = await extractor.extract(
      pdfWithPages({ text: 'a' }, { text: 'b' }),
    );

    expect(sections.map(({ text }) => text)).toEqual(['a', 'b\n\nc']);
  });

  it('adds the text layer to pages where OCR lost words', async () => {
    models.ocrPdf.mockResolvedValue(['| ASV61 |']);

    const [section] = await extractor.extract(
      pdfWithPages({ text: 'ASV61 13.01 0.80 Firmicutes' }),
    );

    expect(section.text).toBe('| ASV61 |\n\nASV61 13.01 0.80 Firmicutes');
  });

  it('rejects files that are not PDFs', async () => {
    expect(await failureOf(new TextEncoder().encode('hello'))).toBe(
      KnowledgeDocumentFailureReason.INVALID_FILE,
    );
    expect(models.ocrPdf).not.toHaveBeenCalled();
  });

  it('rejects PDFs with neither text nor images', async () => {
    models.ocrPdf.mockResolvedValue(['', '']);

    expect(await failureOf(pdfWithPages({}, {}))).toBe(
      KnowledgeDocumentFailureReason.NO_TEXT,
    );
  });
});
