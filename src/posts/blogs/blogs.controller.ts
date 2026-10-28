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
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  OmitType,
} from '@nestjs/swagger';
import { PostType } from '../../mongo/models.js';
import type { Response } from 'express';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '../../auth/auth.types.js';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../../auth/optional-jwt-auth.guard.js';
import { BlogImagesService } from './blog-images.service.js';
import { BlogsService } from './blogs.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import {
  BlogImageUploadDto,
  BlogVideoUploadDto,
  CreateBlogImageUploadDto,
} from '../dto/blog-image.dto.js';
import {
  BlogDetailDto,
  CreateBlogDto,
  MyBlogsQueryDto,
  UpdateBlogDto,
} from '../dto/blog.dto.js';
import { ListPostsQueryDto } from '../dto/list-posts-query.dto.js';
import { PostPageDto } from '../dto/post-response.dto.js';
import { PostsService } from '../posts.service.js';

export class ListBlogsQueryDto extends OmitType(ListPostsQueryDto, ['type']) {}

@ApiTags('blogs')
@Controller('blogs')
export class BlogsController {
  constructor(
    private readonly blogs: BlogsService,
    private readonly posts: PostsService,
    private readonly images: BlogImagesService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a blog; DRAFT by default' })
  @ApiCreatedResponse({ type: BlogDetailDto })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateBlogDto) {
    return this.blogs.create(request.user.sub, dto);
  }

  @Post('images/uploads')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a presigned upload for an image in a blog' })
  @ApiCreatedResponse({ type: BlogImageUploadDto })
  createImageUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateBlogImageUploadDto,
  ) {
    return this.images.createUpload(request.user.sub, dto);
  }

  @Post('videos/uploads')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get a signed Cloudinary upload for a video in a blog',
  })
  @ApiCreatedResponse({ type: BlogVideoUploadDto })
  createVideoUpload() {
    return this.cloudinary.signBlogVideoUpload();
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'List published blogs',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: PostPageDto })
  list(
    @Query() query: ListBlogsQueryDto,
    @Req() request: OptionalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (request.user) response.setHeader('Cache-Control', 'private, no-store');
    return this.posts.list(
      { ...query, type: PostType.BLOG },
      request.user?.sub,
    );
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List your drafts and published blogs, newest created first',
  })
  @ApiOkResponse({ type: PostPageDto })
  mine(
    @Query() query: MyBlogsQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.blogs.listMine(request.user.sub, query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Read a blog; only its author can read a draft',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: BlogDetailDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: OptionalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (request.user) response.setHeader('Cache-Control', 'private, no-store');
    return this.blogs.findOne(id, request.user?.sub);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit your blog, publish or return it to draft' })
  @ApiOkResponse({ type: BlogDetailDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateBlogDto,
  ) {
    return this.blogs.update(id, request.user.sub, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your blog and its interactions' })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.blogs.remove(id, request.user.sub);
  }
}
