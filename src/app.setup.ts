import {
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExpressAdapter } from '@nestjs/platform-express';
import helmet from 'helmet';
import { InvalidInputException } from './common/exceptions/invalid-input.exception.js';

function validationMessages(
  errors: ValidationError[],
  parentPath?: string,
): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const prefix = parentPath ? `${parentPath}.` : '';
    messages.push(
      ...Object.values(error.constraints ?? {}).map(
        (message) => `${prefix}${message}`,
      ),
    );
    const childPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    messages.push(...validationMessages(error.children ?? [], childPath));
  }
  return messages;
}

export function configureApp(app: INestApplication): void {
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
      exceptionFactory: (errors) => {
        const messages = validationMessages(errors);
        return new InvalidInputException(
          'VALIDATION_FAILED',
          messages.join('; '),
          { messages },
        );
      },
    }),
  );
}
