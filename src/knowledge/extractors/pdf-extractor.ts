import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeDocumentFailureReason } from '@prisma/client';
import type * as MuPdf from 'mupdf' with { 'resolution-mode': 'import' };
import {
  type ExtractedSection,
  IngestionError,
  PDF_CONTENT_TYPE,
} from '../ingestion';
import { KnowledgeModelsService } from '../retrieval/knowledge-models.service';

const MIN_IMAGE_PX = 100;
const MIN_IMAGE_PT = 48;
const MAX_IMAGE_PX = 1024;
const MAX_IMAGES_PER_DOCUMENT = 100;
const JPEG_QUALITY = 80;
// share of the text layer's words OCR must keep before the layer is trusted
// over it; Mistral OCR can drop columns of dense, borderless tables
const MIN_OCR_COVERAGE = 0.9;

/**
 * MuPDF pulls out the images; Mistral OCR reads the text, so tables,
 * multi-column layouts and scans come back as Markdown. Images are blanked
 * before OCR since OpenRouter returns at most 8 per PDF.
 */
@Injectable()
export class PdfExtractor {
  private readonly logger = new Logger(PdfExtractor.name);

  constructor(private readonly models: KnowledgeModelsService) {}

  /** Throws `IngestionError` for files that can't be ingested. */
  async extract(file: Uint8Array): Promise<ExtractedSection[]> {
    // ESM-only with top-level await; module: nodenext keeps this a real import()
    const mupdf = await import('mupdf');

    let document: MuPdf.Document;
    try {
      document = mupdf.Document.openDocument(file, PDF_CONTENT_TYPE);
    } catch (error) {
      throw new IngestionError(
        KnowledgeDocumentFailureReason.INVALID_FILE,
        `MuPDF could not open the file: ${String(error)}`,
      );
    }

    try {
      const pdf = document.asPDF();
      if (!pdf) {
        throw new IngestionError(
          KnowledgeDocumentFailureReason.INVALID_FILE,
          'Not a PDF',
        );
      }
      if (document.needsPassword()) {
        throw new IngestionError(
          KnowledgeDocumentFailureReason.ENCRYPTED,
          'The file is password-protected',
        );
      }
      const pages = readPages(mupdf, document);
      blankImages(pdf);
      const texts = await this.models.ocrPdf(
        pdf.saveToBuffer('garbage,compress').asUint8Array(),
      );
      if (texts.length !== pages.length) {
        this.logger.warn(
          `OCR returned ${texts.length} pages for a ${pages.length}-page PDF`,
        );
      }

      const sections = pages.map(({ images, layerText }, index) => {
        const text =
          index === pages.length - 1
            ? texts.slice(index).join('\n\n')
            : (texts[index] ?? '');
        if (coverage(layerText, text) >= MIN_OCR_COVERAGE) {
          return { text, images };
        }
        this.logger.warn(
          `OCR missed text on page ${index + 1}; adding the text layer`,
        );
        return { text: `${text}\n\n${layerText}`.trim(), images };
      });
      if (sections.every(({ text, images }) => !text && !images.length)) {
        throw new IngestionError(
          KnowledgeDocumentFailureReason.NO_TEXT,
          'No page has text or images',
        );
      }
      return sections;
    } finally {
      document.destroy();
    }
  }
}

function readPages(mupdf: typeof MuPdf, document: MuPdf.Document) {
  const seen = new Set<string>();
  const pages: { images: Uint8Array[]; layerText: string }[] = [];
  const count = document.countPages();
  for (let index = 0; index < count; index++) {
    const page = document.loadPage(index);
    const text = page.toStructuredText('preserve-images');
    const images: Uint8Array[] = [];
    text.walk({
      onImageBlock: ([x0, y0, x1, y1], _transform, image) => {
        if (
          seen.size >= MAX_IMAGES_PER_DOCUMENT ||
          image.getImageMask() ||
          x1 - x0 < MIN_IMAGE_PT ||
          y1 - y0 < MIN_IMAGE_PT ||
          image.getWidth() < MIN_IMAGE_PX ||
          image.getHeight() < MIN_IMAGE_PX
        ) {
          return;
        }
        const jpeg = imageToJpeg(mupdf, image);
        const hash = createHash('sha1').update(jpeg).digest('hex');
        if (seen.has(hash)) return;
        seen.add(hash);
        images.push(jpeg);
      },
    });
    pages.push({ images, layerText: text.asText().trim() });
    text.destroy();
    page.destroy();
  }
  return pages;
}

function coverage(reference: string, text: string): number {
  const expected = words(reference);
  if (!expected.length) return 1;
  const found = new Map<string, number>();
  for (const word of words(text)) found.set(word, (found.get(word) ?? 0) + 1);
  let kept = 0;
  for (const word of expected) {
    const left = found.get(word) ?? 0;
    if (left) {
      kept++;
      found.set(word, left - 1);
    }
  }
  return kept / expected.length;
}

function words(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function imageToJpeg(mupdf: typeof MuPdf, image: MuPdf.Image): Uint8Array {
  const scale = Math.min(
    1,
    MAX_IMAGE_PX / Math.max(image.getWidth(), image.getHeight()),
  );
  const width = Math.max(1, Math.round(image.getWidth() * scale));
  const height = Math.max(1, Math.round(image.getHeight() * scale));
  const pixmap = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [0, 0, width, height],
    false,
  );
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  try {
    pixmap.clear(255);
    device.fillImage(image, [width, 0, 0, height, 0, 0], 1);
    device.close();
    return pixmap.asJPEG(JPEG_QUALITY);
  } finally {
    device.destroy();
    pixmap.destroy();
  }
}

function blankImages(pdf: MuPdf.PDFDocument): void {
  for (let number = 1; number < pdf.countObjects(); number++) {
    const object = pdf.newIndirect(number);
    if (!object.isStream() || object.get('Subtype').toString() !== '/Image') {
      continue;
    }
    for (const key of ['SMask', 'Mask', 'Decode', 'ImageMask', 'DecodeParms']) {
      object.delete(key);
    }
    object.put('Width', 1);
    object.put('Height', 1);
    object.put('BitsPerComponent', 8);
    object.put('ColorSpace', pdf.newName('DeviceGray'));
    object.writeStream(new Uint8Array([255]));
  }
}
