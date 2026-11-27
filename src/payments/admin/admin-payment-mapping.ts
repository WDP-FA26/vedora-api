import type { PipelineStage } from 'mongoose';
import { PaymentIntent, PaymentWebhookReceipt } from '../../mongo/models.js';
import {
  purchasedPlanName,
  effectivePlan,
  purchasedLimits,
} from '../../subscriptions/subscription-policy.js';

export const normalizedPlan = {
  $cond: [
    { $eq: ['$planVersion', 2] },
    { $cond: [{ $eq: ['$planCode', 'PRO'] }, 'PRO', 'PLUS'] },
    { $cond: [{ $eq: ['$planCode', 'PREMIUM'] }, 'PRO', 'PLUS'] },
  ],
};
export const cycleExpiry = {
  $add: ['$capturedAt', { $multiply: ['$durationDays', 86400000] }],
};
export interface AdminCustomer {
  id: string;
  username: string;
  fullName: string;
  email: string;
  status: string;
}
export const customerJoin: PipelineStage[] = [
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      pipeline: [
        {
          $project: {
            _id: 0,
            id: '$_id',
            username: 1,
            fullName: 1,
            email: 1,
            status: 1,
            emailVerifiedAt: 1,
          },
        },
      ],
      as: 'customer',
    },
  },
  { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
];
export type AdminIntent = PaymentIntent & {
  customer?: AdminCustomer;
  source?: 'ADMIN_GRANT';
  startsAt?: Date;
  cycleExpiry?: Date;
};
export function membershipRow(row: AdminIntent) {
  if (row.source !== 'ADMIN_GRANT') return orderRow(row);
  return {
    id: row._id,
    userId: row.userId,
    source: row.source,
    planCode: row.planCode,
    startsAt: row.startsAt!.toISOString(),
    expiresAt: row.cycleExpiry!.toISOString(),
    textLimit: row.textLimit!,
    imageLimit: row.imageLimit!,
    customer: row.customer
      ? {
          id: row.customer.id,
          username: row.customer.username,
          fullName: row.customer.fullName,
          email: row.customer.email,
          status: row.customer.status,
        }
      : null,
  };
}
export function orderRow(intent: AdminIntent) {
  const planCode = effectivePlan(intent),
    limits = purchasedLimits(intent);
  const customer = intent.customer;
  return {
    id: intent._id,
    userId: intent.userId,
    customer: customer
      ? {
          id: customer.id,
          username: customer.username,
          fullName: customer.fullName,
          email: customer.email,
          status: customer.status,
        }
      : null,
    planCode,
    originalPlanCode: intent.planCode,
    planVersion: intent.planVersion ?? 1,
    purchasedPlanName: purchasedPlanName(intent),
    durationDays: intent.durationDays,
    textLimit: intent.textLimit ?? limits.text,
    imageLimit: intent.imageLimit ?? limits.images,
    amount: intent.amount.toString(),
    currency: intent.currency,
    status: intent.status,
    invoiceNumber: intent.invoiceNumber,
    paymentCode: intent.paymentCode,
    providerTransactionId: intent.providerTransactionId,
    providerReference: intent.providerReference,
    createdAt: intent.createdAt.toISOString(),
    capturedAt: intent.capturedAt?.toISOString() ?? null,
    paidAt: intent.paidAt?.toISOString() ?? null,
    cancelledAt: intent.cancelledAt?.toISOString() ?? null,
    subscriptionExpiresAt: intent.capturedAt
      ? new Date(
          intent.capturedAt.getTime() + intent.durationDays * 86400000,
        ).toISOString()
      : null,
  };
}
export function receiptRow(row: PaymentWebhookReceipt) {
  return {
    id: row._id,
    intentId: row.intentId,
    providerTransactionId: row.providerTransactionId,
    payloadHash: row.payloadHash,
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
  };
}
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return (
    '"' +
    (/^[=+\-@\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""') +
    '"'
  );
}
