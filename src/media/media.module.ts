import { Module } from '@nestjs/common';
import { CaptionService } from './caption.service.js';
import { TranscriptionService } from './captions/transcription.service.js';
import { CloudinaryWebhookController } from './cloudinary-webhook.controller.js';
import { MediaController } from './media.controller.js';
import { MediaMaintenanceService } from './media-maintenance.service.js';
import { MediaService } from './media.service.js';

@Module({
  controllers: [MediaController, CloudinaryWebhookController],
  providers: [
    MediaService,
    MediaMaintenanceService,
    CaptionService,
    TranscriptionService,
  ],
  exports: [MediaService, CaptionService],
})
export class MediaModule {}
