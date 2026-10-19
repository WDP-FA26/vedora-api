import { Module } from '@nestjs/common';
import { CaptionService } from './caption.service';
import { TranscriptionService } from './captions/transcription.service';
import { CloudinaryWebhookController } from './cloudinary-webhook.controller';
import { MediaController } from './media.controller';
import { MediaMaintenanceService } from './media-maintenance.service';
import { MediaService } from './media.service';

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
