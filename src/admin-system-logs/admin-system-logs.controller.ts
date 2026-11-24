import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { ApiPaginatedResponse } from '../common/pagination/index.js';
import { UserRole } from '../mongo/models.js';
import { AdminSystemLogsService } from './admin-system-logs.service.js';
import { SystemLogDto, SystemLogQueryDto } from './system-log.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/system-logs')
export class AdminSystemLogsController {
  constructor(private readonly logs: AdminSystemLogsService) {}
  @Get()
  @ApiOperation({
    summary: 'Read authenticated administrative mutation history',
  })
  @ApiPaginatedResponse(SystemLogDto)
  findAll(@Query() query: SystemLogQueryDto) {
    return this.logs.findAll(query);
  }
  @Get(':id')
  @ApiOkResponse({ type: SystemLogDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.findOne(id);
  }
}
