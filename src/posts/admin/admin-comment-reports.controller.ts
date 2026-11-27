import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { Roles } from '../../auth-core/roles.decorator.js';
import { RolesGuard } from '../../auth-core/roles.guard.js';
import { ApiPaginatedResponse } from '../../common/pagination/index.js';
import { UserRole } from '../../mongo/models.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import {
  AdminCommentReportDto,
  ReviewCommentReportDto,
} from '../dto/comment-report.dto.js';
import { PostReportsQueryDto } from '../dto/post-interaction.dto.js';
import { CommentReportsService } from '../interactions/comment-reports.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/comment-reports')
export class AdminCommentReportsController {
  constructor(private readonly reports: CommentReportsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List comment reports with global per-comment counts, preserved snapshots and current content versions',
  })
  @ApiPaginatedResponse(AdminCommentReportDto)
  findAll(@Query() query: PostReportsQueryDto) {
    return this.reports.findAll(query);
  }

  @Post(':id/review')
  @ApiBadRequestResponse({
    type: ErrorBodyDto,
    description:
      'REMOVE requires expectedCommentVersion from the current preview (null for deleted comments)',
  })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description:
      'COMMENT_CHANGED if content changed after preview; CONFLICT if the report was already reviewed',
  })
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Dismiss a report or remove the reported comment and resolve related pending reports',
  })
  @ApiOkResponse({ type: AdminCommentReportDto })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: ReviewCommentReportDto,
  ) {
    return this.reports.review(id, request.user.sub, dto);
  }
}
