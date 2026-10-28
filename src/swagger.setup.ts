import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { errorResponses } from './common/exceptions/swagger-error-responses.js';

/** The OpenAPI document, with the shared error body on every error status. */
export function buildApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Vedora API')
    .setDescription('Vedora backend API documentation')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addGlobalResponse(...errorResponses())
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, buildApiDocument(app), {
    jsonDocumentUrl: 'docs/json',
    yamlDocumentUrl: 'docs/yaml',
  });
}
