import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/** Checks a Cloudflare Turnstile token: proof that a browser, not a script, is asking. */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret: string;

  constructor(configService: ConfigService) {
    this.secret = configService.getOrThrow<string>('TURNSTILE_SECRET_KEY');
  }

  /** A token passes once; Cloudflare rejects a second use. */
  async verify(token: string, ip: string | undefined): Promise<boolean> {
    try {
      const response = await fetch(VERIFY_URL, {
        method: 'POST',
        body: new URLSearchParams({
          secret: this.secret,
          response: token,
          ...(ip ? { remoteip: ip } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: boolean };
      return result.success === true;
    } catch (error) {
      this.logger.error(`Turnstile verification failed: ${String(error)}`);
      return false;
    }
  }
}
