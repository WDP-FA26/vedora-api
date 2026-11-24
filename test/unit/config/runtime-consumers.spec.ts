import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { mockDeep } from 'vitest-mock-extended';

describe('environment overrides reach actual backend consumers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('changes both request DTO validation and its public configuration', async () => {
    vi.stubEnv('POST_MAX_WORDS', '3');
    vi.stubEnv('POST_MAX_LENGTH', '20');
    vi.stubEnv('POST_MAX_MEDIA', '1');
    vi.stubEnv('JWT_SECRET', 'never-expose-this-credential');
    const { CreatePostDto } = await import('@src/posts/dto/create-post.dto.js');
    const { publicRuntimeConfig } =
      await import('@src/config/public-config.controller.js');
    expect(
      await validate(
        plainToInstance(CreatePostDto, { type: 'POST', body: 'one two three' }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(CreatePostDto, {
          type: 'POST',
          body: 'one two three four',
        }),
      ),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(CreatePostDto, { type: 'POST', body: 'x'.repeat(21) }),
      ),
    ).not.toHaveLength(0);
    const config = publicRuntimeConfig();
    expect(config.content).toMatchObject({
      postMaxWords: 3,
      postMaxLength: 20,
      postMaxMedia: 1,
    });
    expect(config.version).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(config)).not.toMatch(
      /never-expose|JWT_SECRET|PROMPT_FILE|API_KEY|PASSWORD/,
    );
  });

  it('uses the configured OTP length for generation and verification DTOs', async () => {
    vi.stubEnv('AUTH_OTP_LENGTH', '8');
    const { generateCode } = await import('@src/auth/one-time-code.js');
    const { VerifyEmailDto } =
      await import('@src/auth/dto/email-verification.dto.js');
    expect(generateCode()).toMatch(/^\d{8}$/);
    expect(
      await validate(
        plainToInstance(VerifyEmailDto, {
          email: 'person@example.test',
          code: '12345678',
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(VerifyEmailDto, {
          email: 'person@example.test',
          code: '123456',
        }),
      ),
    ).not.toHaveLength(0);
  });

  it('advances profile cleanup with a small configured batch rather than assuming index 99', async () => {
    vi.stubEnv('PROFILE_IMAGE_CLEANUP_BATCH_SIZE', '2');
    const { ProfilesService } =
      await import('@src/profiles/profiles.service.js');
    type Args = ConstructorParameters<typeof ProfilesService>;
    const users = mockDeep<Args[0]>();
    users.countDocuments.mockResolvedValue(0);
    const rows = [
      {
        id: 'first',
        storageKey: 'first.webp',
        createdAt: new Date('2020-01-01'),
      },
      {
        id: 'last',
        storageKey: 'last.webp',
        createdAt: new Date('2020-01-02'),
      },
    ];
    const exec = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    const limit = vi.fn(() => ({ exec }));
    const find = vi.fn(() => ({ sort: () => ({ limit }) }));
    const uploads = {
      find,
      deleteOne: vi.fn().mockResolvedValue({}),
    } as unknown as Args[4];
    const storage = mockDeep<Args[5]>();
    storage.isConfigured.mockReturnValue(true);
    storage.publicObjectUrl.mockReturnValue('https://fixture.test/image.webp');
    const service = new ProfilesService(
      users,
      mockDeep<Args[1]>(),
      mockDeep<Args[2]>(),
      mockDeep<Args[3]>(),
      uploads,
      storage,
      mockDeep<Args[6]>(),
      mockDeep<Args[7]>(),
    );
    await service.purgeUnusedImages();
    expect(limit).toHaveBeenCalledWith(2);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]).toEqual([
      expect.objectContaining({
        $or: [
          { createdAt: { $gt: rows[1].createdAt } },
          { createdAt: rows[1].createdAt, _id: { $gt: 'last' } },
        ],
      }),
    ]);
  });

  it('keeps the Mongoose message constraint aligned with its request DTO after an override', async () => {
    vi.stubEnv('MESSAGE_MAX_LENGTH', '3000');
    const { Schema, model, deleteModel } = await import('mongoose');
    const { DirectMessageSchema } =
      await import('@src/mongo/schemas/messaging.schema.js');
    const Model = model(
      'EnvMessageConstraintFixture',
      new Schema(DirectMessageSchema.obj),
    );
    try {
      const fields = {
        conversationId: 'conversation',
        senderId: 'sender',
        recipientId: 'recipient',
        clientMessageId: 'client',
        sequence: 1,
      };
      expect(
        new Model({ ...fields, body: 'a'.repeat(2500) }).validateSync(),
      ).toBeUndefined();
      expect(
        new Model({ ...fields, body: 'a'.repeat(3001) }).validateSync()?.errors
          .body,
      ).toBeDefined();
    } finally {
      deleteModel('EnvMessageConstraintFixture');
    }
  });

  it('changes new payment deadlines and codes without rewriting historical deadlines or purchased allowances', async () => {
    vi.stubEnv('PAYMENT_INTENT_TTL_SECONDS', '45');
    vi.stubEnv('PAYMENT_CODE_SUFFIX_LENGTH', '8');
    vi.stubEnv('SUBSCRIPTION_PLUS_TEXT_LIMIT', '444');
    const { PAYMENT_LIFETIME_MS, paymentExpiresAt } =
      await import('@src/payments/payment-expiration.js');
    const { generatePaymentCode } =
      await import('@src/payments/payment-code.js');
    const { SUBSCRIPTION_LIMITS, purchasedLimits } =
      await import('@src/subscriptions/subscription-policy.js');
    const { BillingPlan } = await import('@src/mongo/enums.js');
    expect(PAYMENT_LIFETIME_MS).toBe(45000);
    expect(generatePaymentCode('VED')).toMatch(/^VED[A-Z0-9]{8}$/);
    expect(SUBSCRIPTION_LIMITS.PLUS.text).toBe(444);
    expect(
      purchasedLimits({
        planCode: BillingPlan.PLUS,
        planVersion: 2,
        textLimit: 123,
        imageLimit: 7,
      }),
    ).toEqual({ text: 123, images: 7 });
    expect(
      purchasedLimits({ planCode: BillingPlan.PRO, planVersion: 1 }),
    ).toEqual({ text: 300, images: 10 });
    const createdAt = new Date('2026-11-18T00:00:00Z');
    expect(
      paymentExpiresAt({ createdAt }).getTime() - createdAt.getTime(),
    ).toBe(1800000);
    expect(
      paymentExpiresAt({
        createdAt,
        expiresAt: new Date('2026-11-18T00:15:00Z'),
      }).toISOString(),
    ).toBe('2026-11-18T00:15:00.000Z');
  });

  it('registers the configured cron expression, not the former decorator literal', async () => {
    vi.stubEnv('PAYMENT_EXPIRATION_CRON', '*/7 * * * * *');
    const { PaymentMaintenanceService } =
      await import('@src/payments/payment-maintenance.service.js');
    const options = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      PaymentMaintenanceService.prototype.expireOrders,
    ) as { cronTime: string; waitForCompletion: boolean };
    expect(options).toMatchObject({
      cronTime: '*/7 * * * * *',
      waitForCompletion: true,
    });
  });

  it('changes the moderation input budget without silently changing its default or model input', async () => {
    vi.stubEnv('AI_MODERATION_CONTEXT_MAX_CHARS', '100');
    const { conversationModerationState } =
      await import('@src/ai/guardrails/conversation-state.js');
    const turns = [
      { role: 'user' as const, text: 'a'.repeat(80) },
      { role: 'user' as const, text: 'b'.repeat(80) },
    ];
    const moderated = conversationModerationState(turns);
    expect(typeof moderated).not.toBe('string');
    if (typeof moderated === 'string')
      throw new Error('Expected moderated turns');
    expect(moderated.reduce((sum, turn) => sum + turn.text.length, 0)).toBe(
      100,
    );
    expect(turns.reduce((sum, turn) => sum + turn.text.length, 0)).toBe(160);
  });
});
