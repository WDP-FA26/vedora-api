import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { describe, expect, it } from 'vitest';
import { RawBody } from '../../../src/media/raw-body.decorator.js';

@Controller('raw-body-test')
class RawBodyTestController {
  @Post()
  echo(
    @RawBody() rawBody: Buffer | undefined,
    @Body() _body: Record<string, unknown>,
  ) {
    return {
      isBuffer: Buffer.isBuffer(rawBody),
      text: rawBody ? rawBody.toString('utf8') : null,
    };
  }
}

describe('RawBody decorator', () => {
  it('injects the raw request Buffer when rawBody is enabled', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RawBodyTestController],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();

    try {
      const res = await request(app.getHttpServer())
        .post('/raw-body-test')
        .send({ hello: 'vedora' })
        .expect(201);

      expect(res.body).toEqual({
        isBuffer: true,
        text: '{"hello":"vedora"}',
      });
    } finally {
      await app.close();
    }
  });

  it('injects undefined when rawBody is not enabled on the app', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RawBodyTestController],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: false,
    });
    await app.init();

    try {
      const res = await request(app.getHttpServer())
        .post('/raw-body-test')
        .send({ hello: 'vedora' })
        .expect(201);

      expect(res.body).toEqual({
        isBuffer: false,
        text: null,
      });
    } finally {
      await app.close();
    }
  });
});
