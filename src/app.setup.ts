import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExpressAdapter } from '@nestjs/platform-express';
import helmet from 'helmet';

/**
 * HTTP setup shared by `main.ts` and the e2e tests, so tests exercise the
 * same prefix, validation and security headers as production. The app must
 * be created with `rawBody: true` for Cloudinary notification signatures.
 */
export function configureApp(app: INestApplication): void {
  // Long articles can exceed Express's default 100 KB when encoded as UTF-8.
  // Keep rawBody available for signed webhooks using Nest's parser options.
  (app.getHttpAdapter() as ExpressAdapter).useBodyParser('json', true, {
    limit: '512kb',
  });
  const config = app.get(ConfigService);
  const prefix = config.get<string>('API_PREFIX', 'api/v1');
  const corsOrigin = config.get<string>('CORS_ORIGIN', '*');

  app.use(helmet());
  app.enableCors({
    origin:
      corsOrigin === '*' ? true : corsOrigin.split(',').map((v) => v.trim()),
    credentials: corsOrigin !== '*',
  });
  app.setGlobalPrefix(prefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
