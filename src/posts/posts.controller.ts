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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { PostsService } from './posts.service';

@ApiTags('posts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a post',
    description:
      'Text and/or one video from POST /media/uploads. The post is PROCESSING until the video is ready, then PUBLISHED.',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePostDto,
  ): Promise<PostResponseDto> {
    return this.postsService.create(request.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List published posts, newest first' })
  list(@Query() query: ListPostsQueryDto): Promise<PostPageDto> {
    return this.postsService.list(query);
  }

  @Get(':id')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your post and its videos' })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.postsService.remove(id, request.user.sub);
  }
}
