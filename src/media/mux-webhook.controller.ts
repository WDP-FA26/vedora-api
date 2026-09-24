import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { MuxService } from '../mux/mux.service';
import { MediaService } from './media.service';

/**
 * Mux calls this for upload and asset events. It is public; the signature
 * (`MUX_WEBHOOK_SECRET`) proves the request came from Mux. Register
 * `https://<api>/api/v1/webhooks/mux` in the Mux dashboard.
 */
@ApiExcludeController()
@Controller('webhooks')
export class MuxWebhookController {
  private readonly logger = new Logger(MuxWebhookController.name);

  constructor(
    private readonly mux: MuxService,
    private readonly mediaService: MediaService,
  ) {}

  @Post('mux')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<void> {
    if (!this.mux.webhooksEnabled) {
      throw new ServiceUnavailableException('Mux webhooks are not configured');
    }
    if (!request.rawBody) {
      throw new BadRequestException('Missing body');
    }

    let event;
    try {
      event = await this.mux
        .require()
        .webhooks.unwrap(request.rawBody.toString('utf8'), request.headers);
    } catch (error) {
      this.logger.warn(`Rejected Mux webhook: ${String(error)}`);
      throw new BadRequestException('Invalid webhook signature');
    }
    await this.mediaService.handleWebhook(event);
  }
}
