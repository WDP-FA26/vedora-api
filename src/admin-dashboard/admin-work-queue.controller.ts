import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { UserRole } from '../mongo/models.js';
import { AdminWorkQueueService } from './admin-work-queue.service.js';
import { AdminWorkQueueDto } from './dto/work-queue.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/dashboard/work-queue')
export class AdminWorkQueueController {
  constructor(private readonly queue: AdminWorkQueueService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Global pending admin work, navigation badges and a bounded oldest-first preview',
  })
  @ApiOkResponse({ type: AdminWorkQueueDto })
  get(@Req() request: AuthenticatedRequest) {
    return this.queue.get(request.user.sub);
  }
}
