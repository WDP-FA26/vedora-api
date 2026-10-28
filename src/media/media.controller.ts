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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateUploadDto } from './dto/create-upload.dto.js';
import {
  CreateUploadResponseDto,
  MediaResponseDto,
} from './dto/media-response.dto.js';
import { MediaService } from './media.service.js';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Returns signed Cloudinary upload fields for the browser, and the media ID to pass to POST /posts.',
  })
  @ApiTooManyRequestsResponse({
    description: 'UPLOAD_LIMIT_REACHED: too many uploads not yet posted',
  })
  @ApiServiceUnavailableResponse({
    description: 'Cloudinary is not configured',
  })
  createUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateUploadDto,
  ): Promise<CreateUploadResponseDto> {
    return this.mediaService.createUpload(request.user.sub, dto.type);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of your uploads and its processing status',
  })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MediaResponseDto> {
    return this.mediaService.findOwned(id, request.user.sub);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Discard an upload that is not attached to a post' })
  @ApiConflictResponse({ description: 'The media is attached to a post' })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.mediaService.removeOwned(id, request.user.sub);
  }
}
