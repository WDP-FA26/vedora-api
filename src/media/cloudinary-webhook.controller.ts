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
import type { IncomingHttpHeaders } from 'node:http';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { validatePayload } from '../common/validation';
import { CloudinaryNotification } from './dto/cloudinary-notification';
import { MediaService } from './media.service';
import { RawBody } from './raw-body.decorator';

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
      throw new ServiceUnavailableException('Cloudinary is not configured');
    }
    if (!rawBody) {
      throw new BadRequestException('Missing body');
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
      throw new BadRequestException('Invalid webhook signature');
    }
    const parsed = validatePayload(CloudinaryNotification, JSON.parse(body));
    if (!parsed.value) {
      throw new BadRequestException('Unexpected notification');
    }
    return parsed.value;
  }
}
