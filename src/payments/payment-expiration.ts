import type { QueryFilter } from 'mongoose';
import { PaymentIntent, PaymentStatus } from '../mongo/models.js';

export const PAYMENT_LIFETIME_MS = 30 * 60 * 1000;

/** Older orders keep their original creation time as the deadline anchor. */
export function paymentExpiresAt(intent: {
  createdAt: Date;
  expiresAt?: Date;
}): Date {
  return (
    intent.expiresAt ??
    new Date(intent.createdAt.getTime() + PAYMENT_LIFETIME_MS)
  );
}

export function expiredPaymentFilter(now: Date): QueryFilter<PaymentIntent> {
  return {
    status: PaymentStatus.PENDING,
    $or: [
      { expiresAt: { $lte: now } },
      {
        expiresAt: null,
        createdAt: { $lte: new Date(now.getTime() - PAYMENT_LIFETIME_MS) },
      },
    ],
  };
}
