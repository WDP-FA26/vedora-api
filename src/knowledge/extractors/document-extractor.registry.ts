import { Inject, Injectable } from '@nestjs/common';
import { DocumentExtractor, type DocumentFormat } from './document-extractor';

/** Every registered `DocumentExtractor`; provided in knowledge.module.ts. */
export const DOCUMENT_EXTRACTORS = Symbol('DOCUMENT_EXTRACTORS');

/** Picks the extractor for a file name (at upload) or content type (later). */
@Injectable()
export class DocumentExtractorRegistry {
  private readonly byExtension = new Map<string, DocumentFormat>();
  private readonly byContentType = new Map<string, DocumentExtractor>();

  constructor(@Inject(DOCUMENT_EXTRACTORS) extractors: DocumentExtractor[]) {
    for (const extractor of extractors) {
      for (const format of extractor.formats) {
        this.byExtension.set(format.extension, format);
        this.byContentType.set(format.contentType, extractor);
      }
    }
  }

  /** The accepted extensions, e.g. for error messages and the upload UI. */
  get extensions(): string[] {
    return [...this.byExtension.keys()];
  }

  formatFor(filename: string): DocumentFormat | undefined {
    const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
    return extension ? this.byExtension.get(extension) : undefined;
  }

  extractorFor(contentType: string): DocumentExtractor | undefined {
    return this.byContentType.get(contentType);
  }
}
