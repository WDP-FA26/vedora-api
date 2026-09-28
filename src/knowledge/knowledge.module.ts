import { Module } from '@nestjs/common';
import type { DocumentExtractor } from './extractors/document-extractor';
import {
  DOCUMENT_EXTRACTORS,
  DocumentExtractorRegistry,
} from './extractors/document-extractor.registry';
import { PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';
import { KnowledgeModelsService } from './retrieval/knowledge-models.service';
import { KnowledgeSearchService } from './retrieval/knowledge-search.service';
import { VercelBlobWebhookController } from './vercel-blob-webhook.controller';

/** Support a new file type by adding its `DocumentExtractor` here. */
const extractors = [PdfExtractor];

@Module({
  controllers: [KnowledgeController, VercelBlobWebhookController],
  providers: [
    KnowledgeService,
    KnowledgeMaintenanceService,
    ...extractors,
    {
      provide: DOCUMENT_EXTRACTORS,
      useFactory: (...all: DocumentExtractor[]) => all,
      inject: extractors,
    },
    DocumentExtractorRegistry,
    KnowledgeModelsService,
    KnowledgeIndexService,
    KnowledgeSearchService,
  ],
  exports: [KnowledgeSearchService],
})
export class KnowledgeModule {}
