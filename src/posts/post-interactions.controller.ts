import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../common/pagination';
import {
  CommentBodyDto,
  CommentPageDto,
  CommentResponseDto,
} from './dto/comment.dto';
import {
  CreatePostReportDto,
  PostBookmarkResponseDto,
  PostReportDto,
  PostRepostResponseDto,
} from './dto/post-interaction.dto';
import { PostLikeResponseDto } from './dto/post-like-response.dto';
import { PostReportsService } from './post-reports.service';
import { PostInteractionsService } from './post-interactions.service';

@ApiTags('post-interactions')
@Controller('posts/:postId')
export class PostInteractionsController {
  constructor(
    private readonly interactions: PostInteractionsService,
    private readonly reports: PostReportsService,
  ) {}

  @Get('comments')
  @ApiOperation({ summary: 'List comments on a published post, newest first' })
  @ApiOkResponse({ type: CommentPageDto })
  listComments(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    return this.interactions.listComments(postId, query);
  }

  @Post('comments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Comment on a published post' })
  @ApiCreatedResponse({ type: CommentResponseDto })
  createComment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    return this.interactions.createComment(postId, request.user.sub, dto);
  }

  @Patch('comments/:commentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit your comment' })
  @ApiOkResponse({ type: CommentResponseDto })
  updateComment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    return this.interactions.updateComment(
      postId,
      commentId,
      request.user,
      dto,
    );
  }

  @Delete('comments/:commentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a comment as its author, post author or admin',
  })
  @ApiNoContentResponse()
  removeComment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.interactions.removeComment(postId, commentId, request.user);
  }

  @Put('like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Like a published post (idempotent)' })
  @ApiOkResponse({ type: PostLikeResponseDto })
  like(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostLikeResponseDto> {
    return this.interactions.setLike(postId, request.user.sub, true);
  }

  @Delete('like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove your like (idempotent)' })
  @ApiOkResponse({ type: PostLikeResponseDto })
  unlike(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostLikeResponseDto> {
    return this.interactions.setLike(postId, request.user.sub, false);
  }

  @Put('repost')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Repost a published post (idempotent)' })
  @ApiOkResponse({ type: PostRepostResponseDto })
  repost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostRepostResponseDto> {
    return this.interactions.setRepost(postId, request.user.sub, true);
  }

  @Delete('repost')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Undo your repost (idempotent)' })
  @ApiOkResponse({ type: PostRepostResponseDto })
  unrepost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostRepostResponseDto> {
    return this.interactions.setRepost(postId, request.user.sub, false);
  }

  @Put('bookmark')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save a published post for later (idempotent)' })
  @ApiOkResponse({ type: PostBookmarkResponseDto })
  bookmark(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostBookmarkResponseDto> {
    return this.interactions.setBookmark(postId, request.user.sub, true);
  }

  @Delete('bookmark')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a post from your saved posts (idempotent)' })
  @ApiOkResponse({ type: PostBookmarkResponseDto })
  unbookmark(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostBookmarkResponseDto> {
    return this.interactions.setBookmark(postId, request.user.sub, false);
  }

  @Post('report')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Report a published post to the admins',
    description: 'One report per account per post; not your own posts.',
  })
  @ApiCreatedResponse({ type: PostReportDto })
  @ApiConflictResponse({ description: 'ALREADY_REPORTED (see `code`)' })
  report(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePostReportDto,
  ): Promise<PostReportDto> {
    return this.reports.create(postId, request.user.sub, dto);
  }
}
