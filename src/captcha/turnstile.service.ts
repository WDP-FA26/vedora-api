import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const VERIFY_URL = runtimeConfig.TURNSTILE_VERIFY_URL;
const TIMEOUT_MS = runtimeConfig.TURNSTILE_VERIFY_TIMEOUT_MS;

const turnstileResultSchema = z.object({ success: z.boolean().optional() });

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret: string;

  constructor(configService: ConfigService) {
    this.secret = configService.getOrThrow<string>('TURNSTILE_SECRET_KEY');
  }

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
      const result = turnstileResultSchema.safeParse(await response.json());
      return result.success && result.data.success === true;
    } catch (error) {
      this.logger.error(`Turnstile verification failed: ${String(error)}`);
      return false;
    }
  }
}
