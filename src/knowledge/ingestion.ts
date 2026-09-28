import { KnowledgeDocumentFailureReason } from '@prisma/client';

export const PDF_CONTENT_TYPE = 'application/pdf';

/** Why a document can't be ingested, with the reason stored on its row. */
export class IngestionError extends Error {
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
