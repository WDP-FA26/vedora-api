import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  AiFeature,
  BillingPlan,
  SubscriptionMembership,
} from '@src/mongo/models.js';
import { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

describe('Voice shared text allowance (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  beforeAll(async () => {
    e2e = await createE2eApp('voice_text_quota');
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });
  const memberships = () =>
    e2e.connection.model<SubscriptionMembership>(SubscriptionMembership.name);
  const http = () => request(e2e.app.getHttpServer());

  async function fixture(
    planCode: BillingPlan.PRO | BillingPlan.PLUS = BillingPlan.PRO,
    textLimit = 1,
  ) {
    const user = await createUser(e2e.mongo);
    await memberships().create({
      _id: user.id,
      source: 'ADMIN_GRANT',
      sourceId: randomUUID(),
      planCode,
      textLimit,
      imageLimit: 1,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return {
      user,
      token: await e2e.sign(user),
      usage: e2e.app.get(AiUsageService),
    };
  }

  it('refuses session creation and new turns when Pro has exhausted the shared text allowance', async () => {
    const { user, token, usage } = await fixture();
    const ticket = await usage.consumeVoice(user.id, AiFeature.MEAL_PLAN_CHAT);
    await usage.complete(ticket!);
    await http()
      .get('/api/v1/billing/me')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          usage: { text: { used: 1, remaining: 0 } },
        }),
      );
    await http()
      .post('/api/v1/meal-plan/voice/session')
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(429)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'AI_QUOTA_EXCEEDED' }),
      );
    await http()
      .post('/api/v1/meal-plan/voice/turns')
      .auth(token, { type: 'bearer' })
      .send({
        weekStart: '2026-11-23',
        message: 'Gợi ý bữa trưa chay',
        requestId: randomUUID(),
      })
      .expect(429)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'AI_QUOTA_EXCEEDED' }),
      );
    expect(
      await usage.summary(user.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 1 });
  });

  it('still requires Pro even when a Plus member has text turns available', async () => {
    const { token } = await fixture(BillingPlan.PLUS, 10);
    for (const endpoint of ['session', 'turns']) {
      await http()
        .post(`/api/v1/meal-plan/voice/${endpoint}`)
        .auth(token, { type: 'bearer' })
        .send(
          endpoint === 'session'
            ? {}
            : { weekStart: '2026-11-23', message: 'Gợi ý bữa trưa chay' },
        )
        .expect(403)
        .expect(({ body }) =>
          expect(body).toMatchObject({ code: 'PRO_REQUIRED' }),
        );
    }
  });

  it('releases failed voice reservations in billing so text remains available', async () => {
    const { user, token, usage } = await fixture();
    const ticket = await usage.consumeVoice(user.id, AiFeature.MEAL_PLAN_CHAT);
    await http()
      .get('/api/v1/billing/me')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          usage: { text: { used: 1, remaining: 0 } },
        }),
      );
    await usage.refund(ticket!);
    await http()
      .get('/api/v1/billing/me')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          usage: { text: { used: 0, remaining: 1 } },
        }),
      );
    expect(await usage.consume(user.id, AiFeature.BLOG_CHAT)).not.toBeNull();
  });
});
