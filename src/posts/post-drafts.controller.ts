import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import {
  CreatePostDraftDto,
  DraftUploadRequestDto,
  DraftUploadResponseDto,
  PostDraftDto,
  PostDraftPageDto,
  PostDraftVersionDto,
  SavePostDraftDto,
} from './dto/post-draft.dto.js';
import { PostResponseDto } from './dto/post-response.dto.js';
import { PostDraftsService } from './post-drafts.service.js';

@ApiTags('post-drafts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts/drafts')
export class PostDraftsController {
  constructor(private readonly drafts: PostDraftsService) {}

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get()
  @ApiOkResponse({ type: PostDraftPageDto })
  list(@Req() req: AuthenticatedRequest) {
    return this.drafts.list(req.user.sub);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post()
  @ApiCreatedResponse({ type: PostDraftDto })
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreatePostDraftDto) {
    return this.drafts.create(req.user.sub, dto);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get(':id')
  @ApiOkResponse({ type: PostDraftDto })
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drafts.get(req.user.sub, id);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Patch(':id')
  @ApiOkResponse({ type: PostDraftDto })
  save(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePostDraftDto,
  ) {
    return this.drafts.save(req.user.sub, id, dto);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post(':id/uploads')
  @ApiCreatedResponse({ type: DraftUploadResponseDto })
  upload(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DraftUploadRequestDto,
  ) {
    return this.drafts.upload(req.user.sub, id, dto.mediaId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Delete(':id/media/:mediaId')
  @ApiOkResponse({ type: PostDraftDto })
  removeMedia(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Body() dto: PostDraftVersionDto,
  ) {
    return this.drafts.removeMedia(
      req.user.sub,
      id,
      mediaId,
      dto.expectedVersion,
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOkResponse({ type: PostResponseDto })
  publish(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostDraftVersionDto,
  ) {
    return this.drafts.publish(req.user.sub, id, dto.expectedVersion);
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drafts.remove(req.user.sub, id);
  }
}
