import type { IncomingMessage } from 'node:http';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlobError, del, get } from '@vercel/blob';
import {
  generateClientTokenFromReadWriteToken,
  handleUpload,
  type HandleUploadBody,
} from '@vercel/blob/client';

export interface ClientTokenOptions {
  pathname: string;
  contentType: string;
  maxBytes: number;
  validUntil: number;
}

/**
 * Wraps Vercel Blob. The store is private: blobs are only readable with the
 * token, so every read uses `access: 'private'`. Browsers upload straight to
 * it with a client token, and only the signed upload-completed callback
 * confirms an upload. Calls answer 503 while `BLOB_READ_WRITE_TOKEN` (or, for
 * uploads, `BLOB_CALLBACK_URL`) is empty, like Mux does.
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);
  private readonly token: string;
  /** Where Vercel Blob posts upload-completed callbacks; must be public. */
  private readonly callbackUrl: string;

  constructor(configService: ConfigService) {
    this.token = configService.getOrThrow<string>('BLOB_READ_WRITE_TOKEN');
    this.callbackUrl = configService.getOrThrow<string>('BLOB_CALLBACK_URL');
  }

  /** A token that lets the browser upload exactly one pathname. */
  createClientToken({
    pathname,
    contentType,
    maxBytes,
    validUntil,
  }: ClientTokenOptions): Promise<string> {
    return generateClientTokenFromReadWriteToken({
      token: this.requireToken(),
      pathname,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: maxBytes,
      validUntil,
      onUploadCompleted: { callbackUrl: this.requireCallbackUrl() },
    });
  }

  /**
   * Verifies an upload-completed callback and passes on its pathname.
   * Token requests are refused: tokens only come from `createClientToken`.
   */
  async handleCallback(
    body: HandleUploadBody,
    request: IncomingMessage,
    onUploadCompleted: (pathname: string) => Promise<void>,
  ): Promise<void> {
    try {
      await handleUpload({
        token: this.requireToken(),
        body,
        request,
        onBeforeGenerateToken: () =>
          Promise.reject(new BlobError('Tokens are not issued here')),
        onUploadCompleted: ({ blob }) => onUploadCompleted(blob.pathname),
      });
    } catch (error) {
      // signature and event-type failures; anything else is a 500 to retry
      if (!(error instanceof BlobError)) throw error;
      this.logger.warn(`Rejected Vercel Blob callback: ${error.message}`);
      throw new BadRequestException('Invalid callback');
    }
  }

  /** The blob's bytes, or null when it is gone. */
  async download(pathname: string): Promise<Uint8Array | null> {
    const result = await get(pathname, {
      access: 'private',
      token: this.requireToken(),
    });
    if (result?.statusCode !== 200) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  async delete(pathname: string): Promise<void> {
    await del(pathname, { token: this.requireToken() });
  }

  /**
   * Uploads are only confirmed by Vercel Blob's callback, so they can't
   * start without one. Locally, tunnel the API (e.g. cloudflared).
   */
  private requireCallbackUrl(): string {
    if (!this.callbackUrl) {
      throw new ServiceUnavailableException(
        'File storage callback is not configured',
      );
    }
    return this.callbackUrl;
  }

  private requireToken(): string {
    if (!this.token) {
      throw new ServiceUnavailableException('File storage is not configured');
    }
    return this.token;
  }
}
