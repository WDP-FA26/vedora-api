import { KnowledgeDocumentFailureReason } from '../../mongo/models.js';

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
  images: Uint8Array[];
}
