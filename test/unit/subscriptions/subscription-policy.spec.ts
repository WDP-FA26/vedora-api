import { BillingPlan } from '@src/mongo/enums.js';
import {
  effectivePlan,
  freePeriod,
  PAID_PLANS,
  PLAN_VERSION,
  purchasedPlanName,
  SUBSCRIPTION_LIMITS,
} from '@src/subscriptions/subscription-policy.js';

describe('subscription catalogue compatibility', () => {
  it('exposes catalogue v2 constants and allowance limits', () => {
    expect(PLAN_VERSION).toBe(2);
    expect(PAID_PLANS).toEqual([BillingPlan.PLUS, BillingPlan.PRO]);
    expect(SUBSCRIPTION_LIMITS).toEqual({
      FREE: { text: 5, images: 0 },
      PLUS: { text: 300, images: 10 },
      PRO: { text: 900, images: 40 },
    });
  });

  it('maps v1/legacy and v2 plan codes to effective current plans', () => {
    expect(effectivePlan({ planCode: BillingPlan.PRO })).toBe(BillingPlan.PLUS);
    expect(effectivePlan({ planCode: BillingPlan.PLUS })).toBe(
      BillingPlan.PLUS,
    );
    expect(effectivePlan({ planCode: BillingPlan.PRO, planVersion: 1 })).toBe(
      BillingPlan.PLUS,
    );
    expect(effectivePlan({ planCode: BillingPlan.PREMIUM })).toBe(
      BillingPlan.PRO,
    );
    expect(
      effectivePlan({ planCode: BillingPlan.PREMIUM, planVersion: 1 }),
    ).toBe(BillingPlan.PRO);
    expect(effectivePlan({ planCode: BillingPlan.PLUS, planVersion: 2 })).toBe(
      BillingPlan.PLUS,
    );
    expect(effectivePlan({ planCode: BillingPlan.PRO, planVersion: 2 })).toBe(
      BillingPlan.PRO,
    );
    expect(
      effectivePlan({ planCode: BillingPlan.PREMIUM, planVersion: 2 }),
    ).toBe(BillingPlan.PLUS);
  });

  it('preserves historical purchasedPlanName for v1 and v2 plans', () => {
    expect(purchasedPlanName({ planCode: BillingPlan.PRO })).toBe(
      'Pro (gói cũ)',
    );
    expect(
      purchasedPlanName({ planCode: BillingPlan.PRO, planVersion: 1 }),
    ).toBe('Pro (gói cũ)');
    expect(purchasedPlanName({ planCode: BillingPlan.PREMIUM })).toBe(
      'Premium (gói cũ)',
    );
    expect(
      purchasedPlanName({ planCode: BillingPlan.PREMIUM, planVersion: 1 }),
    ).toBe('Premium (gói cũ)');
    expect(
      purchasedPlanName({ planCode: BillingPlan.PLUS, planVersion: 2 }),
    ).toBe('Plus');
    expect(
      purchasedPlanName({ planCode: BillingPlan.PRO, planVersion: 2 }),
    ).toBe('Pro');
  });

  it('uses Bangkok midnight across a UTC date boundary', () => {
    expect(freePeriod(new Date('2026-11-09T16:59:59Z'))).toEqual({
      key: 'free:2026-11-09',
      startsAt: new Date('2026-11-08T17:00:00Z'),
      expiresAt: new Date('2026-11-09T17:00:00Z'),
    });
    expect(freePeriod(new Date('2026-11-09T17:00:00Z'))).toEqual({
      key: 'free:2026-11-10',
      startsAt: new Date('2026-11-09T17:00:00Z'),
      expiresAt: new Date('2026-11-10T17:00:00Z'),
    });
  });
});
