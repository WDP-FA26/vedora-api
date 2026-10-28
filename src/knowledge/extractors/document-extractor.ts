import { KnowledgeDocumentFailureReason } from '../../mongo/models.js';

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
