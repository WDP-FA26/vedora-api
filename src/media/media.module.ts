import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaMaintenanceService } from './media-maintenance.service';
import { MediaService } from './media.service';
import { MuxWebhookController } from './mux-webhook.controller';

@Module({
  controllers: [MediaController, MuxWebhookController],
  providers: [MediaService, MediaMaintenanceService],
  exports: [MediaService],
})
export class MediaModule {}
