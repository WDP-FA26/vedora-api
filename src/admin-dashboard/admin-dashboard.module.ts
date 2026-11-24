import { Module } from '@nestjs/common';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminWorkQueueController } from './admin-work-queue.controller.js';
import { AdminWorkQueueService } from './admin-work-queue.service.js';

@Module({
  controllers: [AdminDashboardController, AdminWorkQueueController],
  providers: [AdminDashboardService, AdminWorkQueueService],
})
export class AdminDashboardModule {}
