import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { BlobError } from '@vercel/blob';
import type { HandleUploadBody } from '@vercel/blob/client';
import type { Request } from 'express';
import { ProfilesService } from '../profiles/profiles.service';

/**
 * Vercel Blob calls this when a client upload finishes. It is public; the
 * `x-vercel-signature` HMAC (keyed by `BLOB_READ_WRITE_TOKEN`) proves the
 * request came from Vercel. Set `BLOB_CALLBACK_URL` to
 * `https://<api>/api/v1/webhooks/vercel-blob`.
 */
@ApiExcludeController()
@Controller('webhooks')
export class VercelBlobWebhookController {
  private readonly logger = new Logger(VercelBlobWebhookController.name);

  constructor(private readonly profilesService: ProfilesService) {}

  @Post('vercel-blob')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Body() body: HandleUploadBody,
    @Req() request: Request,
  ): Promise<void> {
    try {
      if (body?.type !== 'blob.upload-completed')
        throw new BadRequestException('Expected an upload-completed callback');
      const pathname = body.payload?.blob?.pathname;
      if (pathname?.startsWith('profiles/'))
        await this.profilesService.handleImageCallback(body, request);
      else throw new BadRequestException('Unknown Blob callback pathname');
    } catch (error) {
      // signature and event-type failures; anything else is a 500 to retry
      if (!(error instanceof BlobError)) throw error;
      this.logger.warn(`Rejected Vercel Blob callback: ${error.message}`);
      throw new BadRequestException('Invalid callback');
    }
  }
}
