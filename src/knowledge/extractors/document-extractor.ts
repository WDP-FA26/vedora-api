import { KnowledgeDocumentFailureReason } from '@prisma/client';

/** A file type an extractor accepts, matched by upload file name. */
export interface DocumentFormat {
  contentType: string;
  /** Lowercase, without the dot; also the extension of the blob pathname. */
  extension: string;
}

/** A file that can't be ingested, with the reason stored on the document. */
export class DocumentExtractionError extends Error {
  constructor(
    readonly reason: KnowledgeDocumentFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractedSection {
  text: string;
  /** JPEG */
  images: Uint8Array[];
}

/**
 * Turns an uploaded file into sections (a page for PDFs), in order.
 * Support a new file type by extending this and listing the subclass in
 * `DOCUMENT_EXTRACTORS` (knowledge.module.ts).
 */
export abstract class DocumentExtractor {
  abstract readonly formats: readonly DocumentFormat[];

  /** Throws `DocumentExtractionError` for files that can't be ingested. */
  abstract extract(
    file: Uint8Array,
    contentType: string,
  ): Promise<ExtractedSection[]>;
}
