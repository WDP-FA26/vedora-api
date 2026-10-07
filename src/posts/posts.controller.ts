import {
  Body,
  Controller,
  Delete,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CreatePostDto } from './dto/create-post.dto';
import { RecordViewsDto } from './dto/post-interaction.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { PostViewsService } from './post-views.service';
import { PostsService } from './posts.service';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly views: PostViewsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a post',
    description:
      'Text and/or up to four videos from POST /media/uploads. The post is PROCESSING until every video is ready, then PUBLISHED.',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePostDto,
  ): Promise<PostResponseDto> {
    return this.postsService.create(request.user.sub, dto);
  }

  @Post('views')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Record that posts were seen',
    description:
      'Send the posts that were at least half on screen for a second, batched every few seconds. Counts are deduplicated per viewer and saved in the background, so `viewCount` lags by a few seconds.',
    security: [{}, { bearer: [] }],
  })
  recordViews(
    @Req() request: OptionalAuthenticatedRequest & { ip?: string },
    @Body() dto: RecordViewsDto,
  ): void {
    this.views.record(
      request.user?.sub ?? `ip:${request.ip ?? 'unknown'}`,
      dto.postIds,
    );
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'List published posts, newest first',
    description:
      'Public read. Send a Bearer token to receive your isLiked state; an invalid supplied token returns 401.',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: PostPageDto })
  list(
    @Query() query: ListPostsQueryDto,
    @Req() request: OptionalAuthenticatedRequest,
  ): Promise<PostPageDto> {
    return this.postsService.list(query, request.user?.sub);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get a post',
    description:
      'Public read for published posts. Its author also sees it while PROCESSING or FAILED, and polls this until it is published.',
    security: [{}, { bearer: [] }],
  })
  findOne(
    @Req() request: OptionalAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PostResponseDto> {
    return this.postsService.findOne(id, request.user?.sub);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your post and its videos' })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.postsService.remove(id, request.user.sub);
  }
}
