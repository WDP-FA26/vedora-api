import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../../mongo/models';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../../common/pagination';
import { AdminPostsService } from './admin-posts.service';
import { AdminPostDto, AdminPostsQueryDto } from '../dto/admin-post.dto';
import { PostsService } from '../posts.service';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/posts')
export class AdminPostsController {
  constructor(
    private readonly adminPosts: AdminPostsService,
    private readonly posts: PostsService,
  ) {}

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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete anyone's post and its videos" })
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.posts.removeAsAdmin(id);
  }
}
