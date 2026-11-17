import {
  Body,
  Controller,
  Get,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { configureApp } from '../../src/app.setup.js';
import { AppExceptionFilter } from '../../src/common/exceptions/app-exception.filter.js';
import { buildApiDocument, setupSwagger } from '../../src/swagger.setup.js';

class NestedItemDto {
  @IsString()
  label!: string;
}

class ProbeBodyDto {
  @ValidateNested({ each: true })
  @Type(() => NestedItemDto)
  items!: NestedItemDto[];
}

@Controller('probe')
class ProbeController {
  @Get()
  ok(): { ok: boolean } {
    return { ok: true };
  }

  @Post()
  echo(@Body() body: ProbeBodyDto): ProbeBodyDto {
    return body;
  }
}

describe('configureApp & setupSwagger', () => {
  it('applies prefix, CORS origins, validation exceptionFactory, and Swagger setup', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              API_PREFIX: 'api/v1',
              CORS_ORIGIN: 'https://vedora.vn, https://admin.vedora.vn',
            }),
          ],
        }),
      ],
      controllers: [ProbeController],
    }).compile();

    const app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    app.useGlobalFilters(new AppExceptionFilter());
    configureApp(app);
    setupSwagger(app);
    const doc = buildApiDocument(app);
    expect(doc.info.title).toBe('Vedora API');
    await app.init();

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .set('Origin', 'https://vedora.vn');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://vedora.vn',
    );

    const badRes = await request(app.getHttpServer())
      .post('/api/v1/probe')
      .send({ items: [{ label: 123 }] });
    expect(badRes.status).toBe(400);
    expect(badRes.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      details: { messages: ['items.0.label must be a string'] },
    });

    await app.close();
  });

  it('handles wildcard CORS_ORIGIN=* without requiring credentials', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({ API_PREFIX: 'api/v1', CORS_ORIGIN: '*' })],
        }),
      ],
      controllers: [ProbeController],
    }).compile();

    const app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .set('Origin', 'https://any.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://any.example.com',
    );

    await app.close();
  });
});
