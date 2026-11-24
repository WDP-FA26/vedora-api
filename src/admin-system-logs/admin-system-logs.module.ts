import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminSystemLogsController } from './admin-system-logs.controller.js';
import { AdminSystemLogsService } from './admin-system-logs.service.js';
import { AdminSystemLogsInterceptor } from './admin-system-logs.interceptor.js';

@Module({
  controllers: [AdminSystemLogsController],
  providers: [
    AdminSystemLogsService,
    { provide: APP_INTERCEPTOR, useClass: AdminSystemLogsInterceptor },
  ],
})
export class AdminSystemLogsModule {}
