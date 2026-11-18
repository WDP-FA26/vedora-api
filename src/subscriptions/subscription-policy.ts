import { runtimeConfig } from '../config/runtime-config.js';
import { zonedMidnight, nextCalendarDay } from '../config/time-zone.js';
import { BillingPlan } from '../mongo/enums.js';

export const PLAN_VERSION = 2;
export const SUBSCRIPTION_LIMITS = {
  FREE: {
    text: runtimeConfig.SUBSCRIPTION_FREE_TEXT_LIMIT,
    images: runtimeConfig.SUBSCRIPTION_FREE_IMAGE_LIMIT,
  },
  PLUS: {
    text: runtimeConfig.SUBSCRIPTION_PLUS_TEXT_LIMIT,
    images: runtimeConfig.SUBSCRIPTION_PLUS_IMAGE_LIMIT,
  },
  PRO: {
    text: runtimeConfig.SUBSCRIPTION_PRO_TEXT_LIMIT,
    images: runtimeConfig.SUBSCRIPTION_PRO_IMAGE_LIMIT,
  },
} as const;
export type SubscriptionPlan = keyof typeof SUBSCRIPTION_LIMITS;
export type PaidPlan = BillingPlan.PLUS | BillingPlan.PRO;
export const PAID_PLANS = [BillingPlan.PLUS, BillingPlan.PRO] as const;

// Historical purchase contract for rows created before allowance snapshots existed.
// Changing the catalogue env must never retroactively change these entitlements.
const HISTORICAL_LIMITS = {
  PLUS: { text: 300, images: 10 },
  PRO: { text: 900, images: 40 },
} as const;

export function purchasedLimits(payment: {
  planCode: BillingPlan;
  planVersion?: number;
  textLimit?: number;
  imageLimit?: number;
}) {
  const legacy = HISTORICAL_LIMITS[effectivePlan(payment)];
  return {
    text: payment.textLimit ?? legacy.text,
    images: payment.imageLimit ?? legacy.images,
  };
}

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
    timeZone: runtimeConfig.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const startsAt = zonedMidnight(day, runtimeConfig.APP_TIMEZONE);
  return {
    key: `free:${day}`,
    startsAt,
    expiresAt: zonedMidnight(nextCalendarDay(day), runtimeConfig.APP_TIMEZONE),
  };
}
