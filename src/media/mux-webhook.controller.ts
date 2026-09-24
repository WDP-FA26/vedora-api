import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { UnwrapWebhookEvent } from '@mux/ts/resources/webhooks/webhooks';
import type { IncomingHttpHeaders } from 'node:http';
import { MuxService } from '../mux/mux.service';
import { MediaService } from './media.service';
import { RawBody } from './raw-body.decorator';

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
  async receive(
    @RawBody() rawBody: Buffer | undefined,
    @Headers() headers: IncomingHttpHeaders,
  ): Promise<void> {
    if (!this.mux.webhooksEnabled) {
      throw new ServiceUnavailableException('Mux webhooks are not configured');
    }
    if (!rawBody) {
      throw new BadRequestException('Missing body');
    }
    const event = await this.verify(rawBody, headers);
    await this.mediaService.handleWebhook(event);
  }

  private async verify(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<UnwrapWebhookEvent> {
    try {
      return await this.mux
        .require()
        .webhooks.unwrap(rawBody.toString('utf8'), headers);
    } catch (error) {
      this.logger.warn(`Rejected Mux webhook: ${String(error)}`);
      throw new BadRequestException('Invalid webhook signature');
    }
  }
}
