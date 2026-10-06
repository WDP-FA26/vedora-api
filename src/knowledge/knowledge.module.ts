import { Module } from '@nestjs/common';
import { PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';
import { KnowledgeModelsService } from './retrieval/knowledge-models.service';
import { KnowledgeSearchService } from './retrieval/knowledge-search.service';

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
