import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AiService } from '@nestjs/ai';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
import { AiCostCall, PostStatus, UserRole } from '../../src/mongo/models.js';
import { TurnstileService } from '../../src/captcha/turnstile.service.js';
import { PostSearchIndexService } from '../../src/posts/search/post-search-index.service.js';
import { ContentModerationService } from '../../src/moderation/content-moderation.service.js';
import { AdminAiCostsService } from '../../src/admin-ai-costs/admin-ai-costs.service.js';
import {
  createTestMongoUrl,
  prepareTestDatabase,
  dropTestDatabase,
} from '../support/mongo-test-db.js';
import { createUser } from '../support/fixtures.js';
import { fakeOpenAI } from '../support/fake-openai.js';

describe('OpenAI-only application wiring (HTTP fixture + real Mongo)', () => {
  const provider = fakeOpenAI(4091);
  let app: INestApplication<App>;
  let mongo: MongoService;
  let token: string;
  beforeAll(async () => {
    await provider.start();
    process.env.DATABASE_URL = createTestMongoUrl('openai_adapter');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TurnstileService)
      .useValue({ verify: () => Promise.resolve(true) })
      .overrideProvider(PostSearchIndexService)
      .useValue({ schedule: vi.fn(), remove: vi.fn() })
      .compile();
    app = module.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    const user = await createUser(mongo, { role: UserRole.ADMIN });
    token = await app
      .get(JwtService)
      .signAsync({ sub: user.id, username: user.username });
  });
  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
    await provider.close();
  });

  it('boots with an empty OpenRouter key and uses native structured output', async () => {
    expect(app.get(ConfigService).get('OPENROUTER_API_KEY')).toBe('');
    const result = await app.get(AiService).generateObject({
      prompt: 'A recipe title',
      schema: z.object({ title: z.string() }),
    });
    expect(result.object.title).toBe('Fixture tofu soup');
    expect(provider.requests.at(-1)?.path).toBe('/v1/responses');
  });

  it('publishes a safe post through native Decisions and records OpenAI usage without a fabricated price', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .auth(token, { type: 'bearer' })
      .send({ type: 'POST', body: 'A vegetarian tofu soup recipe.' })
      .expect(201);
    expect((result.body as { status: string }).status).toBe(
      PostStatus.PUBLISHED,
    );
    const rows = await mongo.connection
      .model<AiCostCall>(AiCostCall.name)
      .find({ gateway: 'openai' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.operation === 'MODERATION')).toBe(true);
    expect(
      rows.every((row) => row.provider === 'openai' && row.costUsd === null),
    ).toBe(true);
    await expect(
      app.get(AdminAiCostsService).reconcile(rows[0].id),
    ).rejects.toThrow(/Direct OpenAI/);
  });

  it('streams an actual guest nutrition route through the native provider, including its guardrail', async () => {
    const session = await request(app.getHttpServer())
      .post('/api/v1/nutrition-chat/guest-session')
      .send({ turnstileToken: 'fixture' })
      .expect(201);
    const guestToken = (session.body as { token: string }).token;
    const result = await request(app.getHttpServer())
      .post('/api/v1/nutrition-chat')
      .auth(guestToken, { type: 'bearer' })
      .send({
        messages: [
          { role: 'user', text: 'How do I cook vegetarian tofu soup?' },
        ],
      })
      .expect(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    const text = result.text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) =>
        z
          .object({ type: z.string(), delta: z.string().optional() })
          .parse(JSON.parse(line.slice(6))),
      )
      .filter((part) => part.type === 'text-delta')
      .map((part) => part.delta ?? '')
      .join('');
    expect(text).toBe(provider.replyText);
    expect(
      provider.requests.some(
        (row) => row.path === '/v1/responses' && row.stream,
      ),
    ).toBe(true);
    expect(
      provider.requests.every((row) =>
        ['/v1/responses', '/v1/decisions'].includes(row.path),
      ),
    ).toBe(true);
  });

  it('fails closed when the native provider refuses to evaluate content', async () => {
    provider.refuse(true);
    try {
      await expect(
        app
          .get(ContentModerationService)
          .requireAllowed([{ kind: 'text', text: 'fixture refused input' }]),
      ).rejects.toThrow();
    } finally {
      provider.refuse(false);
    }
  });
});
