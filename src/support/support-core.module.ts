import { Module } from '@nestjs/common';
import { SupportSyncService } from './support-sync.service.js';

@Module({
  providers: [SupportSyncService],
  exports: [SupportSyncService],
})
export class SupportCoreModule {}
