import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CaptionService } from './caption.service.js';
import { TranscriptionService } from './captions/transcription.service.js';
import { CloudinaryWebhookController } from './cloudinary-webhook.controller.js';
import { MediaController } from './media.controller.js';
import { MediaMaintenanceService } from './media-maintenance.service.js';
import { MediaService } from './media.service.js';
import { PostModerationService } from './post-moderation.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [MediaController, CloudinaryWebhookController],
  providers: [
    MediaService,
    MediaMaintenanceService,
    PostModerationService,
    CaptionService,
    TranscriptionService,
  ],
  exports: [MediaService, CaptionService, PostModerationService],
})
export class MediaModule {}
