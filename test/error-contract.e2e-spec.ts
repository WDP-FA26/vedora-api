import request from 'supertest';
import { z } from 'zod';
import { ERROR_CODES } from '../src/common/exceptions/error-code.js';
import { buildApiDocument } from '../src/swagger.setup.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** The envelope every error response uses, with `code` limited to ERROR_CODES. */
const errorBodySchema = z.object({
  statusCode: z.number(),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

describe('Error contract (HTTP and Swagger)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp('error_contract_e2e');
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('error responses', () => {
    it('returns the shared envelope for an unauthenticated request', async () => {
      const response = await request(e2e.app.getHttpServer())
        .get('/api/v1/auth/me')
        .expect(401);

      expect(errorBodySchema.parse(response.body)).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('returns VALIDATION_FAILED with details.messages for an invalid body', async () => {
      const response = await request(e2e.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({})
        .expect(400);

      const body = errorBodySchema.parse(response.body);
      expect(body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
      });
      expect(Array.isArray(body.details?.messages)).toBe(true);
    });

    it('returns NOT_FOUND for an unknown route', async () => {
      const response = await request(e2e.app.getHttpServer())
        .get('/api/v1/no-such-route')
        .expect(404);

      expect(errorBodySchema.parse(response.body)).toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('Swagger document', () => {
    it('publishes the error body with the code enum', () => {
      const document = buildApiDocument(e2e.app);

      expect(document.components?.schemas?.ErrorBodyDto).toMatchObject({
        properties: { code: { enum: [...ERROR_CODES] } },
      });
    });

    it('documents the shared error body on every operation', () => {
      const document = buildApiDocument(e2e.app);
      const operations = Object.values(document.paths).flatMap((item) =>
        HTTP_METHODS.flatMap((method) => {
          const operation = item[method];
          return operation ? [operation] : [];
        }),
      );

      expect(operations.length).toBeGreaterThan(0);
      for (const operation of operations) {
        expect(operation.responses['400']).toMatchObject({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorBodyDto' },
            },
          },
        });
      }
    });
  });
});
