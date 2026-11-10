import { BillingPlan } from '../../../src/mongo/enums.js';
import {
  effectivePlan,
  freePeriod,
  purchasedPlanName,
} from '../../../src/subscriptions/subscription-policy.js';

describe('subscription catalogue compatibility', () => {
  it('does not reinterpret the original Pro as the new Pro', () => {
    expect(effectivePlan({ planCode: BillingPlan.PRO })).toBe('PLUS');
    expect(effectivePlan({ planCode: BillingPlan.PREMIUM })).toBe('PRO');
    expect(effectivePlan({ planCode: BillingPlan.PRO, planVersion: 2 })).toBe(
      'PRO',
    );
    expect(purchasedPlanName({ planCode: BillingPlan.PRO })).toBe(
      'Pro (gói cũ)',
    );
  });
  it('uses Bangkok midnight across a UTC date boundary', () => {
    expect(freePeriod(new Date('2026-11-09T16:59:59Z'))).toEqual({
      key: 'free:2026-11-09',
      startsAt: new Date('2026-11-08T17:00:00Z'),
      expiresAt: new Date('2026-11-09T17:00:00Z'),
    });
    expect(freePeriod(new Date('2026-11-09T17:00:00Z')).key).toBe(
      'free:2026-11-10',
    );
  });
});
