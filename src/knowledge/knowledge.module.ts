import { Module } from '@nestjs/common';
import { PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';
import { KnowledgeModelsService } from './retrieval/knowledge-models.service';
import { KnowledgeSearchService } from './retrieval/knowledge-search.service';
import { VercelBlobWebhookController } from './vercel-blob-webhook.controller';
import { ProfilesModule } from '../profiles/profiles.module';

@Module({
  imports: [ProfilesModule],
  controllers: [KnowledgeController, VercelBlobWebhookController],
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
