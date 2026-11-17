import { BillingPlan, PaymentStatus } from '../../../src/mongo/models.js';
import {
  csvCell,
  customerJoin,
  cycleExpiry,
  normalizedPlan,
  orderRow,
  receiptRow,
  type AdminIntent,
} from '../../../src/payments/admin/admin-payment-mapping.js';

function makeIntent(overrides: Partial<AdminIntent> = {}): AdminIntent {
  return {
    _id: 'intent-1',
    id: 'intent-1',
    userId: 'user-1',
    planCode: BillingPlan.PLUS,
    planVersion: 2,
    textLimit: 300,
    imageLimit: 10,
    durationDays: 30,
    amount: 49000n,
    currency: 'VND',
    status: PaymentStatus.PENDING,
    invoiceNumber: 'VED-INV-1',
    paymentCode: 'VED123456',
    activeIntentKey: 'user-1',
    bankCode: 'VCB',
    bankGateway: 'Vietcombank',
    accountNumber: '0012345678',
    accountHolder: 'VEDORA',
    storeName: 'Vedora',
    transferContent: 'VED123456',
    providerTransactionId: null,
    providerReference: null,
    paidAt: null,
    capturedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('admin-payment-mapping', () => {
  it('defines aggregation helpers for normalizedPlan, cycleExpiry, and customerJoin', () => {
    expect(normalizedPlan).toHaveProperty('$cond');
    expect(cycleExpiry).toEqual({
      $add: ['$capturedAt', { $multiply: ['$durationDays', 86400000] }],
    });
    expect(customerJoin).toHaveLength(2);
  });

  it('maps v2 orderRow with customer and timestamps', () => {
    const capturedAt = new Date('2026-10-02T01:00:00.000Z');
    const paidAt = new Date('2026-10-02T00:59:50.000Z');
    const row = orderRow(
      makeIntent({
        planCode: BillingPlan.PRO,
        planVersion: 2,
        textLimit: 900,
        imageLimit: 40,
        amount: 9007199254740993n,
        status: PaymentStatus.SUCCEEDED,
        providerTransactionId: 'BANK-99',
        providerReference: 'FT-99',
        capturedAt,
        paidAt,
        customer: {
          id: 'user-1',
          username: 'alice',
          fullName: 'Alice',
          email: 'alice@example.test',
          status: 'ACTIVE',
        },
      }),
    );

    expect(row).toEqual({
      id: 'intent-1',
      userId: 'user-1',
      customer: {
        id: 'user-1',
        username: 'alice',
        fullName: 'Alice',
        email: 'alice@example.test',
        status: 'ACTIVE',
      },
      planCode: BillingPlan.PRO,
      originalPlanCode: BillingPlan.PRO,
      planVersion: 2,
      purchasedPlanName: 'Pro',
      durationDays: 30,
      textLimit: 900,
      imageLimit: 40,
      amount: '9007199254740993',
      currency: 'VND',
      status: PaymentStatus.SUCCEEDED,
      invoiceNumber: 'VED-INV-1',
      paymentCode: 'VED123456',
      providerTransactionId: 'BANK-99',
      providerReference: 'FT-99',
      createdAt: '2026-10-01T00:00:00.000Z',
      capturedAt: '2026-10-02T01:00:00.000Z',
      paidAt: '2026-10-02T00:59:50.000Z',
      cancelledAt: null,
      subscriptionExpiresAt: '2026-11-01T01:00:00.000Z',
    });
  });

  it('maps legacy v1 / missing planVersion intents with fallback limits and null customer', () => {
    const cancelledAt = new Date('2026-10-03T12:00:00.000Z');
    const legacyPro = orderRow(
      makeIntent({
        planCode: BillingPlan.PRO,
        planVersion: undefined,
        textLimit: undefined,
        imageLimit: undefined,
        status: PaymentStatus.CANCELLED,
        cancelledAt,
        customer: undefined,
      }),
    );
    expect(legacyPro).toMatchObject({
      customer: null,
      planCode: BillingPlan.PLUS,
      originalPlanCode: BillingPlan.PRO,
      planVersion: 1,
      purchasedPlanName: 'Pro (gói cũ)',
      textLimit: 300,
      imageLimit: 10,
      capturedAt: null,
      paidAt: null,
      cancelledAt: '2026-10-03T12:00:00.000Z',
      subscriptionExpiresAt: null,
    });

    const legacyPremium = orderRow(
      makeIntent({
        planCode: BillingPlan.PREMIUM,
        planVersion: 1,
        textLimit: undefined,
        imageLimit: undefined,
      }),
    );
    expect(legacyPremium).toMatchObject({
      planCode: BillingPlan.PRO,
      originalPlanCode: BillingPlan.PREMIUM,
      planVersion: 1,
      purchasedPlanName: 'Premium (gói cũ)',
      textLimit: 900,
      imageLimit: 40,
    });
  });

  it('maps receiptRow to sanitized projection with ISO timestamp', () => {
    const createdAt = new Date('2026-10-05T08:00:00.000Z');
    const row = receiptRow({
      _id: 'rec-1',
      id: 'rec-1',
      intentId: null,
      providerTransactionId: 'BANK-1',
      payloadHash: 'abc123',
      outcome: 'PAYMENT_CODE_MISSING',
      createdAt,
    });

    expect(row).toEqual({
      id: 'rec-1',
      intentId: null,
      providerTransactionId: 'BANK-1',
      payloadHash: 'abc123',
      outcome: 'PAYMENT_CODE_MISSING',
      createdAt: '2026-10-05T08:00:00.000Z',
    });
  });

  it('formats CSV cells safely with quote doubling and spreadsheet formula escaping', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(49000)).toBe('"49000"');
    expect(csvCell('hello "world"')).toBe('"hello ""world"""');

    for (const prefix of ['=', '+', '-', '@', '\t', '\r', '\n']) {
      expect(csvCell(`${prefix}SUM("A1")`)).toBe(`"'${prefix}SUM(""A1"")"`);
    }
  });
});
