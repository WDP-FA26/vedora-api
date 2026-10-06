import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { StorageWebhookController } from './storage-webhook.controller';
import { StorageWebhookGuard } from './storage-webhook.guard';

@Module({
  imports: [KnowledgeModule, ProfilesModule],
  controllers: [StorageWebhookController],
  providers: [StorageWebhookGuard],
})
export class StorageWebhookModule {}
