import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AiFeature, BillingPlan, PaymentStatus } from '../enums';
import { collectionSchema, indexName } from './common';
import { Identified } from './user.schema';

@Schema(collectionSchema('payment_intents'))
export class PaymentIntent extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, enum: Object.values(BillingPlan), required: true })
  planCode!: BillingPlan;

  @Prop({ type: Number, required: true })
  durationDays!: number;

  /** Int64 in the database; read as `bigint`. */
  @Prop({ type: BigInt, required: true })
  amount!: bigint;

  @Prop({ type: String, required: true, default: 'VND' })
  currency!: string;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    required: true,
    default: PaymentStatus.PENDING,
  })
  status!: PaymentStatus;

  @Prop({ type: String, required: true })
  invoiceNumber!: string;

  @Prop({ type: String, required: true })
  paymentCode!: string;

  @Prop({ type: String, default: null })
  activeIntentKey!: string | null;

  @Prop({ type: String, required: true })
  bankCode!: string;

  @Prop({ type: String, required: true })
  bankGateway!: string;

  @Prop({ type: String, required: true })
  accountNumber!: string;

  @Prop({ type: String, required: true })
  accountHolder!: string;

  @Prop({ type: String, required: true })
  storeName!: string;

  @Prop({ type: String, required: true })
  transferContent!: string;

  @Prop({ type: String, default: null })
  providerTransactionId!: string | null;

  @Prop({ type: String, default: null })
  providerReference!: string | null;

  @Prop({ type: Date, default: null })
  paidAt!: Date | null;

  @Prop({ type: Date, default: null })
  capturedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PaymentIntentSchema = SchemaFactory.createForClass(PaymentIntent);
PaymentIntentSchema.index(
  { invoiceNumber: 1 },
  {
    unique: true,
    name: indexName('payment_intents', ['invoiceNumber'], 'key'),
  },
);
PaymentIntentSchema.index(
  { paymentCode: 1 },
  {
    unique: true,
    name: indexName('payment_intents', ['paymentCode'], 'key'),
  },
);
PaymentIntentSchema.index(
  { activeIntentKey: 1 },
  {
    unique: true,
    name: indexName('payment_intents', ['activeIntentKey'], 'key'),
    partialFilterExpression: { activeIntentKey: { $type: 'string' } },
  },
);
PaymentIntentSchema.index(
  { providerTransactionId: 1 },
  {
    unique: true,
    name: indexName('payment_intents', ['providerTransactionId'], 'key'),
    partialFilterExpression: { providerTransactionId: { $type: 'string' } },
  },
);
PaymentIntentSchema.index(
  { userId: 1, createdAt: 1 },
  { name: indexName('payment_intents', ['userId', 'createdAt'], 'idx') },
);
PaymentIntentSchema.index(
  { userId: 1, status: 1, capturedAt: 1 },
  {
    name: indexName(
      'payment_intents',
      ['userId', 'status', 'capturedAt'],
      'idx',
    ),
  },
);

@Schema(collectionSchema('payment_requests', 'created'))
export class PaymentRequest extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  actorId!: string;

  @Prop({ type: String, required: true })
  requestKey!: string;

  @Prop({ type: String, required: true })
  payloadHash!: string;

  @Prop({ type: String, required: true })
  intentId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PaymentRequestSchema =
  SchemaFactory.createForClass(PaymentRequest);
PaymentRequestSchema.index(
  { actorId: 1, requestKey: 1 },
  {
    unique: true,
    name: indexName('payment_requests', ['actorId', 'requestKey'], 'key'),
  },
);

@Schema(collectionSchema('payment_webhook_receipts', 'created'))
export class PaymentWebhookReceipt extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  providerTransactionId!: string;

  @Prop({ type: String, required: true })
  payloadHash!: string;

  @Prop({ type: String, required: true })
  outcome!: string;

  @Prop({ type: String, default: null })
  intentId!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PaymentWebhookReceiptSchema = SchemaFactory.createForClass(
  PaymentWebhookReceipt,
);
PaymentWebhookReceiptSchema.index(
  { providerTransactionId: 1, createdAt: 1 },
  {
    name: indexName(
      'payment_webhook_receipts',
      ['providerTransactionId', 'createdAt'],
      'idx',
    ),
  },
);
PaymentWebhookReceiptSchema.index(
  { intentId: 1, createdAt: 1 },
  {
    name: indexName(
      'payment_webhook_receipts',
      ['intentId', 'createdAt'],
      'idx',
    ),
  },
);

@Schema(collectionSchema('ai_usage', 'none'))
export class AiUsage extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date, required: true })
  day!: Date;

  @Prop({ type: String, enum: Object.values(AiFeature), required: true })
  feature!: AiFeature;

  @Prop({ type: Number, required: true, default: 0 })
  count!: number;
}

export const AiUsageSchema = SchemaFactory.createForClass(AiUsage);
AiUsageSchema.index(
  { userId: 1, day: 1, feature: 1 },
  {
    unique: true,
    name: indexName('ai_usage', ['userId', 'day', 'feature'], 'key'),
  },
);
