import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { FollowSuggestionsService } from './follow-suggestions.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [NotificationsModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, FollowSuggestionsService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
