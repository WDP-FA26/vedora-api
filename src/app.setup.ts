import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

/**
 * HTTP setup shared by `main.ts` and the e2e tests, so tests exercise the
 * same prefix, validation and security headers as production. The app must
 * be created with `rawBody: true` for Mux webhook signatures.
 */
export function configureApp(app: INestApplication): void {
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
