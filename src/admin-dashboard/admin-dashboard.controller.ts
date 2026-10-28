import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { DashboardDto, DashboardQueryDto } from './dto/dashboard.dto.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'ADMIN role required',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Admin aggregates: current snapshots and a Bangkok date range of up to 90 inclusive days',
  })
  @ApiOkResponse({ type: DashboardDto })
  @ApiBadRequestResponse({
    type: ErrorBodyDto,
    description:
      'Invalid/partial date range, more than 90 days or unsupported query field',
  })
  get(@Query() query: DashboardQueryDto): Promise<DashboardDto> {
    return this.dashboard.get(query);
  }
}
