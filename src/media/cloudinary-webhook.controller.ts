import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { IncomingHttpHeaders } from 'node:http';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { validatePayload } from '../common/validation.js';
import { CloudinaryNotification } from './dto/cloudinary-notification.js';
import { MediaService } from './media.service.js';
import { RawBody } from './raw-body.decorator.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

/**
 * Cloudinary calls this for upload and eager events. It is public; the
 * signature (keyed by `CLOUDINARY_API_SECRET`) proves the request came from
 * Cloudinary. Register `https://<api>/api/v1/webhooks/cloudinary` under
 * Settings → Webhook Notifications for the Upload and Eager types.
 */
@ApiExcludeController()
@Controller('webhooks')
export class CloudinaryWebhookController {
  private readonly logger = new Logger(CloudinaryWebhookController.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly mediaService: MediaService,
  ) {}

  @Post('cloudinary')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @RawBody() rawBody: Buffer | undefined,
    @Headers() headers: IncomingHttpHeaders,
  ): Promise<void> {
    if (!this.cloudinary.configured) {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Cloudinary is not configured',
      );
    }
    if (!rawBody) {
      throw new InvalidInputException('BAD_REQUEST', 'Missing body');
    }
    const notification = this.verify(rawBody.toString('utf8'), headers);
    await this.mediaService.handleNotification(notification);
  }

  private verify(
    body: string,
    headers: IncomingHttpHeaders,
  ): CloudinaryNotification {
    const timestamp = headers['x-cld-timestamp'];
    const signature = headers['x-cld-signature'];
    if (
      typeof timestamp !== 'string' ||
      typeof signature !== 'string' ||
      !this.cloudinary.verifyNotification(body, timestamp, signature)
    ) {
      this.logger.warn('Rejected Cloudinary notification: bad signature');
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Invalid webhook signature',
      );
    }
    const parsed = validatePayload(CloudinaryNotification, JSON.parse(body));
    if (!parsed.value) {
      throw new InvalidInputException('BAD_REQUEST', 'Unexpected notification');
    }
    return parsed.value;
  }
}
