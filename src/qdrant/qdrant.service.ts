import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';

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

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.cause instanceof Error)
    return `${error.message} (${error.cause.message})`;
  return error.message;
}
