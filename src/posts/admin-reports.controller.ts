import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../common/pagination';
import {
  AdminPostReportDto,
  PostReportsQueryDto,
  ReviewPostReportDto,
} from './dto/post-interaction.dto';
import { PostReportsService } from './post-reports.service';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: PostReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List post reports, newest first' })
  @ApiPaginatedResponse(AdminPostReportDto)
  findAll(
    @Query() query: PostReportsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostReportDto>> {
    return this.reports.findAll(query);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close a pending report',
    description:
      'Deleting the reported post (DELETE /admin/posts/:id) removes its reports instead.',
  })
  @ApiOkResponse({ type: AdminPostReportDto })
  @ApiConflictResponse({ description: 'The report was already reviewed' })
  review(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewPostReportDto,
  ): Promise<AdminPostReportDto> {
    return this.reports.review(id, request.user.sub, dto.status);
  }
}
