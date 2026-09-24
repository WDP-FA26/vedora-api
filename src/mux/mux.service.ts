import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Mux from '@mux/ts';

/**
 * Holds the Mux client. Endpoints that need Mux answer 503 while
 * `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` are empty, like Google sign-in does.
 */
@Injectable()
export class MuxService {
  private readonly client: Mux | null;
  /** Empty when webhooks aren't set up (local dev); see `webhooksEnabled`. */
  readonly webhookSecret: string;

  constructor(configService: ConfigService) {
    const tokenId = configService.get<string>('MUX_TOKEN_ID', '');
    const tokenSecret = configService.get<string>('MUX_TOKEN_SECRET', '');
    this.webhookSecret = configService.get<string>('MUX_WEBHOOK_SECRET', '');
    this.client =
      tokenId && tokenSecret
        ? new Mux({
            tokenId,
            tokenSecret,
            webhookSecret: this.webhookSecret || null,
          })
        : null;
  }

  /**
   * Without webhooks nothing tells the API that an upload finished, so reads
   * of pending media ask Mux directly instead.
   */
  get webhooksEnabled(): boolean {
    return this.webhookSecret !== '';
  }

  get configured(): boolean {
    return this.client !== null;
  }

  require(): Mux {
    if (!this.client) {
      throw new ServiceUnavailableException('Video uploads are not configured');
    }
    return this.client;
  }
}
