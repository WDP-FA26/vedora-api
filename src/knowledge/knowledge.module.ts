import { Module } from '@nestjs/common';
import { PdfExtractor } from './extractors/pdf-extractor.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service.js';
import { KnowledgeModelsService } from './retrieval/knowledge-models.service.js';
import { KnowledgeSearchService } from './retrieval/knowledge-search.service.js';

@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    KnowledgeMaintenanceService,
    PdfExtractor,
    KnowledgeModelsService,
    KnowledgeIndexService,
    KnowledgeSearchService,
  ],
  exports: [KnowledgeService, KnowledgeSearchService],
})
export class KnowledgeModule {}
