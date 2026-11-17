import type { Model } from 'mongoose';
import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import {
  BillingPlan,
  PaymentWebhookReceipt,
  UserRole,
} from '../../../src/mongo/models.js';
import type {
  BillingCatalogDto,
  BillingOverviewDto,
  CreatePaymentDto,
  PaymentDto,
} from '../../../src/payments/payment.dto.js';
import {
  PaymentReconciliationController,
  PaymentsController,
  SePayWebhookController,
} from '../../../src/payments/payments.controller.js';
import type { PaymentsService } from '../../../src/payments/payments.service.js';
import { PLAN_VERSION } from '../../../src/subscriptions/subscription-policy.js';

describe('PaymentsController', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const intentId = '00000000-0000-4000-8000-000000000002';
  const request = {
    user: { sub: userId, username: 'member', role: UserRole.USER },
  } as AuthenticatedRequest;

  let service: ReturnType<typeof mockDeep<PaymentsService>>;
  let controller: PaymentsController;

  beforeEach(() => {
    service = mockDeep<PaymentsService>();
    controller = new PaymentsController(service);
  });

  it('returns the server billing catalog from plans()', () => {
    const catalog = {
      planVersion: PLAN_VERSION,
      paymentsEnabled: true,
      freeLimits: { textLimit: 5, imageLimit: 0 },
      plans: [],
    } as BillingCatalogDto;
    service.catalog.mockReturnValue(catalog);

    expect(controller.plans()).toBe(catalog);
    expect(service.catalog).toHaveBeenCalledOnce();
  });

  it('delegates me() to payments.overview with authenticated user sub', async () => {
    const overview = {
      membership: { planCode: 'FREE', startsAt: null, expiresAt: null },
      pendingPayment: null,
      recentPayments: [],
    } as unknown as BillingOverviewDto;
    service.overview.mockResolvedValue(overview);

    await expect(controller.me(request)).resolves.toBe(overview);
    expect(service.overview).toHaveBeenCalledExactlyOnceWith(userId);
  });

  it('delegates create() with user sub, planCode, and idempotency key', async () => {
    const payment = { id: intentId } as PaymentDto;
    service.create.mockResolvedValue(payment);
    const dto: CreatePaymentDto = {
      planCode: BillingPlan.PLUS,
      planVersion: PLAN_VERSION,
    };

    await expect(
      controller.create(request, dto, 'idem-key-123456'),
    ).resolves.toBe(payment);
    expect(service.create).toHaveBeenCalledExactlyOnceWith(
      userId,
      BillingPlan.PLUS,
      'idem-key-123456',
    );
  });

  it('delegates create() with undefined key when header is omitted', async () => {
    const dto: CreatePaymentDto = {
      planCode: BillingPlan.PRO,
      planVersion: PLAN_VERSION,
    };
    service.create.mockResolvedValue({ id: intentId } as PaymentDto);

    await controller.create(request, dto);
    expect(service.create).toHaveBeenCalledExactlyOnceWith(
      userId,
      BillingPlan.PRO,
      undefined,
    );
  });

  it('delegates get() and cancel() with intent id and authenticated user sub', async () => {
    const payment = { id: intentId } as PaymentDto;
    service.get.mockResolvedValue(payment);
    service.cancel.mockResolvedValue(payment);

    await expect(controller.get(intentId, request)).resolves.toBe(payment);
    expect(service.get).toHaveBeenCalledExactlyOnceWith(intentId, userId);

    await expect(controller.cancel(intentId, request)).resolves.toBe(payment);
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith(intentId, userId);
  });
});

describe('SePayWebhookController', () => {
  it('calls bankWebhook and returns { success: true }', async () => {
    const service = mockDeep<PaymentsService>();
    service.bankWebhook.mockResolvedValue(undefined);
    const controller = new SePayWebhookController(service);
    const body = { id: 123, transferAmount: 49000 };

    await expect(controller.webhook(body)).resolves.toEqual({ success: true });
    expect(service.bankWebhook).toHaveBeenCalledExactlyOnceWith(body);
  });

  it('propagates validation or database errors so provider retries', async () => {
    const service = mockDeep<PaymentsService>();
    service.bankWebhook.mockRejectedValue(new Error('DB failure'));
    const controller = new SePayWebhookController(service);

    await expect(controller.webhook({})).rejects.toThrow('DB failure');
  });
});

describe('PaymentReconciliationController', () => {
  it('queries latest 50 webhook receipts sorted newest-first and strips extra fields', async () => {
    const createdAt = new Date('2026-11-01T10:00:00Z');
    const exec = vi.fn().mockResolvedValue([
      {
        id: 'receipt-1',
        _id: 'receipt-1',
        providerTransactionId: 'BANK-101',
        payloadHash: 'hash-101',
        outcome: 'CAPTURED',
        intentId: 'intent-1',
        createdAt,
        rawSecret: 'must-not-leak',
      },
    ]);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const model = { find } as unknown as Model<PaymentWebhookReceipt>;

    const controller = new PaymentReconciliationController(model);
    const result = await controller.receipts();

    expect(find).toHaveBeenCalledOnce();
    expect(sort).toHaveBeenCalledExactlyOnceWith({ createdAt: -1, _id: -1 });
    expect(limit).toHaveBeenCalledExactlyOnceWith(50);
    expect(exec).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        id: 'receipt-1',
        providerTransactionId: 'BANK-101',
        payloadHash: 'hash-101',
        outcome: 'CAPTURED',
        intentId: 'intent-1',
        createdAt,
      },
    ]);
    expect(result[0]).not.toHaveProperty('rawSecret');
  });
});
