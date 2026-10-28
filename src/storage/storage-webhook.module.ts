import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { StorageWebhookController } from './storage-webhook.controller.js';
import { StorageWebhookGuard } from './storage-webhook.guard.js';

@Module({
  imports: [KnowledgeModule, ProfilesModule],
  controllers: [StorageWebhookController],
  providers: [StorageWebhookGuard],
})
export class StorageWebhookModule {}
