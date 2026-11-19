import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CaptionsModule } from './captions/captions.module.js';
import { CloudinaryWebhookController } from './cloudinary-webhook.controller.js';
import { MediaController } from './media.controller.js';
import { MediaMaintenanceService } from './media-maintenance.service.js';
import { MediaService } from './media.service.js';
import { PostModerationService } from './post-moderation.service.js';
import { PostEvidenceService } from './post-evidence.service.js';

@Module({
  imports: [NotificationsModule, CaptionsModule],
  controllers: [MediaController, CloudinaryWebhookController],
  providers: [
    MediaService,
    MediaMaintenanceService,
    PostModerationService,
    PostEvidenceService,
  ],
  exports: [MediaService, PostModerationService, PostEvidenceService],
})
export class MediaModule {}
