import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Body,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../../mongo/models.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { Roles } from '../../auth-core/roles.decorator.js';
import { RolesGuard } from '../../auth-core/roles.guard.js';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../../common/pagination/index.js';
import { AdminPostsService } from './admin-posts.service.js';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import {
  AdminPostDto,
  AdminPostsQueryDto,
  ModeratePostDto,
  RemovePostDto,
  RestorePostDto,
} from '../dto/admin-post.dto.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'Insufficient account permissions',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/posts')
export class AdminPostsController {
  constructor(private readonly adminPosts: AdminPostsService) {}

  @Get()
  @ApiOperation({
    summary: 'List every post, newest first',
    description: 'Includes posts that are still PROCESSING or FAILED.',
  })
  @ApiPaginatedResponse(AdminPostDto)
  findAll(
    @Query() query: AdminPostsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostDto>> {
    return this.adminPosts.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a post with the caption tracks of its videos',
    description:
      'Each track links to its WebVTT file on Cloudinary, which holds the transcript.',
  })
  @ApiOkResponse({ type: AdminPostDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<AdminPostDto> {
    return this.adminPosts.findOne(id);
  }

  @Post(':id/moderation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decide a post held for review, or overturn a rejection',
    description:
      'List the queue with GET /admin/posts?status=PENDING_REVIEW (or REJECTED). APPROVE publishes the post; REJECT blocks it. The decision, admin and note are stored in `moderation`.',
  })
  @ApiOkResponse({ type: AdminPostDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'The post is not PENDING_REVIEW or REJECTED',
  })
  moderate(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModeratePostDto,
  ): Promise<AdminPostDto> {
    return this.adminPosts.moderate(
      id,
      request.user.sub,
      dto.decision,
      dto.note,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Soft-delete anyone's post so it can be appealed or restored",
    description:
      'Atomically marks the post REMOVED, resolves pending reports, and stores notifications for the author (POST_REMOVED with postId, including admin-owned posts) and reporters (REPORTED_POST_REMOVED). Publishes events only after commit; notification persistence failures roll back removal.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'The post is already removed',
  })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto?: RemovePostDto,
  ): Promise<void> {
    await this.adminPosts.remove(id, request.user.sub, dto?.reason);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a soft-deleted post',
    description:
      'Returns the post to its status before removal and closes any active appeal ticket as APPROVED.',
  })
  @ApiOkResponse({ type: AdminPostDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'The post is not REMOVED',
  })
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto?: RestorePostDto,
  ): Promise<AdminPostDto> {
    return this.adminPosts.restore(id, request.user.sub, dto?.note);
  }
}
