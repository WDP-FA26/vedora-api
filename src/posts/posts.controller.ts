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
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { PostsService } from './posts.service';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get a post',
    description: 'Poll this while your post is PROCESSING.',
  })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PostResponseDto> {
    return this.postsService.findOne(id, request.user.sub);
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
