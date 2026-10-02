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
import { PostLikeResponseDto } from './dto/post-like-response.dto';
import { PostInteractionsService } from './post-interactions.service';

@ApiTags('post-interactions')
@Controller('posts/:postId')
export class PostInteractionsController {
  constructor(private readonly interactions: PostInteractionsService) {}

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
}
