import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { MessagingEventsModule } from '../messaging/messaging-events.module.js';
import { FollowSuggestionsService } from './follow-suggestions.service.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';
import { ProfileSearchModule } from './search/profile-search.module.js';

@Module({
  imports: [NotificationsModule, MessagingEventsModule, ProfileSearchModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, FollowSuggestionsService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
