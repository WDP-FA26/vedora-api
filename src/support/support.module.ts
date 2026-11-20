import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PostsAdminModule } from '../posts/admin/posts-admin.module.js';
import { PostsModule } from '../posts/posts.module.js';
import { PostSearchModule } from '../posts/search/post-search.module.js';
import { AdminSupportController } from './admin-support.controller.js';
import { AdminSupportService } from './admin-support.service.js';
import { SupportCoreModule } from './support-core.module.js';
import { SupportMaintenanceService } from './support-maintenance.service.js';
import { SupportAttachmentsController } from './support-attachments.controller.js';
import { SupportAttachmentsService } from './support-attachments.service.js';
import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  imports: [
    SupportCoreModule,
    PostsModule,
    PostsAdminModule,
    MediaModule,
    PostSearchModule,
    NotificationsModule,
  ],
  controllers: [
    SupportController,
    SupportAttachmentsController,
    AdminSupportController,
  ],
  providers: [
    SupportService,
    AdminSupportService,
    SupportAttachmentsService,
    SupportMaintenanceService,
  ],
})
export class SupportModule {}
