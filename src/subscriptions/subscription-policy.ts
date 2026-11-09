import { BillingPlan } from '../mongo/enums.js';

export const PLAN_VERSION = 2;
export const SUBSCRIPTION_LIMITS = {
  FREE: { text: 5, images: 0 },
  PLUS: { text: 300, images: 10 },
  PRO: { text: 900, images: 40 },
} as const;
export type SubscriptionPlan = keyof typeof SUBSCRIPTION_LIMITS;
export type PaidPlan = BillingPlan.PLUS | BillingPlan.PRO;
export const PAID_PLANS = [BillingPlan.PLUS, BillingPlan.PRO] as const;

export function effectivePlan(payment: {
  planCode: BillingPlan;
  planVersion?: number;
}): PaidPlan {
  if (payment.planVersion === PLAN_VERSION)
    return payment.planCode === BillingPlan.PRO
      ? BillingPlan.PRO
      : BillingPlan.PLUS;
  return payment.planCode === BillingPlan.PREMIUM
    ? BillingPlan.PRO
    : BillingPlan.PLUS;
}

export function purchasedPlanName(payment: {
  planCode: BillingPlan;
  planVersion?: number;
}): string {
  if (payment.planVersion === PLAN_VERSION)
    return effectivePlan(payment) === BillingPlan.PRO ? 'Pro' : 'Plus';
  return payment.planCode === BillingPlan.PREMIUM
    ? 'Premium (gói cũ)'
    : 'Pro (gói cũ)';
}

export function freePeriod(now: Date) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const startsAt = new Date(`${day}T00:00:00+07:00`);
  return {
    key: `free:${day}`,
    startsAt,
    expiresAt: new Date(startsAt.getTime() + 86_400_000),
  };
}
