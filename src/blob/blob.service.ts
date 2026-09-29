import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Holds the shared Vercel Blob credentials. Knowledge PDFs request private
 * access and profile images request public access; the store must support the
 * requested mode.
 * Endpoints that need Blob answer 503 while `BLOB_READ_WRITE_TOKEN` is empty,
 * like Mux does.
 */
@Injectable()
export class BlobService {
  private readonly token: string;
  /** Where Vercel Blob posts upload-completed callbacks; must be public. */
  private readonly callbackUrl: string;

  constructor(configService: ConfigService) {
    this.token = configService.get<string>('BLOB_READ_WRITE_TOKEN', '');
    this.callbackUrl = configService.get<string>('BLOB_CALLBACK_URL', '');
  }

  /**
   * Uploads are only confirmed by Vercel Blob's callback, so they can't
   * start without one. Locally, tunnel the API (e.g. cloudflared).
   */
  requireCallbackUrl(): string {
    if (!this.callbackUrl) {
      throw new ServiceUnavailableException(
        'File storage callback is not configured',
      );
    }
    return this.callbackUrl;
  }

  /** The read-write token for `@vercel/blob` calls. */
  require(): string {
    if (!this.token) {
      throw new ServiceUnavailableException('File storage is not configured');
    }
    return this.token;
  }
}
