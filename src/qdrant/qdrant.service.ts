import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';

/** How long startup waits for Qdrant before refusing to start. */
const STARTUP_TIMEOUT_MS = 5_000;

@Injectable()
export class QdrantService extends QdrantClient implements OnModuleInit {
  private readonly url: string;

  constructor(configService: ConfigService) {
    const url = configService.getOrThrow<string>('QDRANT_URL');
    super({
      url,
      apiKey: configService.get<string>('QDRANT_API_KEY') || undefined,
      port: null,
    });
    this.url = url;
  }

  /**
   * The API cannot answer search or assistant requests without Qdrant, so a
   * bad URL, key or an unreachable server stops startup instead of surfacing
   * on the first request.
   */
  async onModuleInit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`no answer within ${STARTUP_TIMEOUT_MS / 1000}s`)),
        STARTUP_TIMEOUT_MS,
      );
    });

    try {
      const probe = this.getCollections();
      // When the timeout wins, the request may still settle later; don't let
      // its rejection crash the process.
      probe.catch(() => undefined);
      await Promise.race([probe, timeout]);
    } catch (error) {
      throw new ExternalServiceException(
        'qdrant',
        `Qdrant at ${this.url} is not reachable: ${describeError(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Node's fetch reports a refused connection only in `cause`. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.cause instanceof Error)
    return `${error.message} (${error.cause.message})`;
  return error.message;
}
