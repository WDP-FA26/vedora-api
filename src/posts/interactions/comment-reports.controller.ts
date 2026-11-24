import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { CommentReportDto } from '../dto/comment-report.dto.js';
import { CreatePostReportDto } from '../dto/post-interaction.dto.js';
import { CommentReportsService } from './comment-reports.service.js';

@ApiTags('post-interactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts/:postId/comments/:commentId/report')
export class CommentReportsController {
  constructor(private readonly reports: CommentReportsService) {}

  @Post()
  @ApiOperation({ summary: 'Report a comment or reply for admin review' })
  @ApiCreatedResponse({ type: CommentReportDto })
  create(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePostReportDto,
  ) {
    return this.reports.create(postId, commentId, request.user.sub, dto);
  }
}
