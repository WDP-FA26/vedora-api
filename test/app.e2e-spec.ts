import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { assetReady } from '../src/media/media.fixtures';
import { PrismaService } from '../src/prisma/prisma.service';

const WEBHOOK_SECRET = 'e2e-webhook-secret';

function signWebhook(payload: string, key = WEBHOOK_SECRET) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', key)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Vedora API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: DeepMockProxy<PrismaService>;
  let token: string;

  beforeAll(async () => {
    prisma = mockDeep<PrismaService>();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    token = await app.get(JwtService).signAsync({
      sub: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
      username: 'vedora.user',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/posts', () => {
    it('requires a signed-in user', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .send({ type: 'POST', body: 'Xin chào' })
        .expect(401);
    });

    it('accepts at most four media items', async () => {
      const mediaIds = Array.from({ length: 5 }, () => crypto.randomUUID());

      const response = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .auth(token, { type: 'bearer' })
        .send({ type: 'POST', mediaIds })
        .expect(400);

      expect(response.body).toMatchObject({
        message: ['mediaIds must contain no more than 4 elements'],
      });
    });

    it('rejects fields the DTO does not declare', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .auth(token, { type: 'bearer' })
        .send({ type: 'POST', body: 'Xin chào', status: 'PUBLISHED' })
        .expect(400);

      expect(response.body).toMatchObject({
        message: ['property status should not exist'],
      });
    });

    it('rejects BLOG posts until blogs exist', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .auth(token, { type: 'bearer' })
        .send({ type: 'BLOG', body: 'Bài dài' })
        .expect(400);
    });
  });

  describe('POST /api/v1/webhooks/mux', () => {
    const payload = JSON.stringify(assetReady(42));

    it('accepts events signed over the raw body', async () => {
      prisma.mediaAsset.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/mux')
        .set('content-type', 'application/json')
        .set('mux-signature', signWebhook(payload))
        .send(payload)
        .expect(204);

      expect(prisma.mediaAsset.findFirst).toHaveBeenCalled();
    });

    it('rejects events with a bad signature', async () => {
      prisma.mediaAsset.findFirst.mockClear();

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/mux')
        .set('content-type', 'application/json')
        .set('mux-signature', signWebhook(payload, 'wrong-secret'))
        .send(payload)
        .expect(400);

      expect(prisma.mediaAsset.findFirst).not.toHaveBeenCalled();
    });
  });
});
