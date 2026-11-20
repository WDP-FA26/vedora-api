import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import {
  CreateSupportAttachmentUploadDto,
  SupportAttachmentUploadDto,
} from './dto/support.dto.js';
import { SupportAttachmentsService } from './support-attachments.service.js';

@ApiTags('support')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@UseGuards(JwtAuthGuard)
@Controller('support/attachments')
export class SupportAttachmentsController {
  constructor(private readonly attachments: SupportAttachmentsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Get a presigned upload for an image to attach to a support message',
    description:
      'Users and admins both use this. PUT the image to upload.url, then send the returned id in attachmentIds when creating a ticket or message. Unsent uploads are purged after 2 days.',
  })
  @ApiCreatedResponse({ type: SupportAttachmentUploadDto })
  @ApiPayloadTooLargeResponse({ type: ErrorBodyDto })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({ type: ErrorBodyDto })
  createUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateSupportAttachmentUploadDto,
  ): Promise<SupportAttachmentUploadDto> {
    return this.attachments.createUpload(request.user.sub, dto);
  }
}
