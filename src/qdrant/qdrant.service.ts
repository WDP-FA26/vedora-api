import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

@Injectable()
export class QdrantService extends QdrantClient {
  constructor(configService: ConfigService) {
    // port: null keeps the URL's own port; otherwise a URL without one (or
    // with https' default :443, which URL parsing drops) gets :6333
    super({
      url: configService.getOrThrow<string>('QDRANT_URL'),
      apiKey: configService.get<string>('QDRANT_API_KEY') || undefined,
      port: null,
    });
  }
}
