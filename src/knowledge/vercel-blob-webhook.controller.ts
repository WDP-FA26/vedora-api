import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { HandleUploadBody } from '@vercel/blob/client';
import type { Request } from 'express';
import { KnowledgeService } from './knowledge.service';

/**
 * Vercel Blob calls this when a client upload finishes. It is public; the
 * `x-vercel-signature` HMAC (keyed by `BLOB_READ_WRITE_TOKEN`) proves the
 * request came from Vercel. Set `BLOB_CALLBACK_URL` to
 * `https://<api>/api/v1/webhooks/vercel-blob`.
 */
@ApiExcludeController()
@Controller('webhooks')
export class VercelBlobWebhookController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post('vercel-blob')
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(
    @Body() body: HandleUploadBody,
    @Req() request: Request,
  ): Promise<void> {
    return this.knowledgeService.handleCallback(body, request);
  }
}
