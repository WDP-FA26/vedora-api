import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BillingPlan } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

export type SubscriptionSource = 'PAYMENT' | 'ADMIN_GRANT';

/** One current assignment per user. Expiry never revives an older purchase. */
@Schema(collectionSchema('subscription_memberships'))
export class SubscriptionMembership extends Identified {
  @Prop({ type: String }) _id!: string;
  @Prop({ type: String, enum: ['PAYMENT', 'ADMIN_GRANT'], required: true })
  source!: SubscriptionSource;
  @Prop({ type: String, required: true }) sourceId!: string;
  @Prop({
    type: String,
    enum: [BillingPlan.PLUS, BillingPlan.PRO],
    required: true,
  })
  planCode!: BillingPlan.PLUS | BillingPlan.PRO;
  @Prop({ type: Date, required: true }) startsAt!: Date;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
  @Prop({ type: Number, required: true, min: 0 }) textLimit!: number;
  @Prop({ type: Number, required: true, min: 0 }) imageLimit!: number;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const SubscriptionMembershipSchema = SchemaFactory.createForClass(
  SubscriptionMembership,
);
SubscriptionMembershipSchema.index({ expiresAt: 1, planCode: 1 });

/** Administrative benefits are deliberately separate from financial orders. */
@Schema(collectionSchema('subscription_grants'))
export class SubscriptionGrant extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true }) userId!: string;
  @Prop({ type: String, required: true }) actorId!: string;
  @Prop({ type: String, required: true }) reason!: string;
  @Prop({ type: String, required: true }) requestKey!: string;
  @Prop({ type: String, required: true }) payloadHash!: string;
  @Prop({ type: Number, required: true }) catalogVersion!: number;
  @Prop({
    type: String,
    enum: [BillingPlan.PLUS, BillingPlan.PRO],
    required: true,
  })
  planCode!: BillingPlan.PLUS | BillingPlan.PRO;
  @Prop({ type: Number, required: true, min: 1 }) durationDays!: number;
  @Prop({ type: Number, required: true, min: 0 }) textLimit!: number;
  @Prop({ type: Number, required: true, min: 0 }) imageLimit!: number;
  @Prop({ type: Date, required: true }) startsAt!: Date;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const SubscriptionGrantSchema =
  SchemaFactory.createForClass(SubscriptionGrant);
SubscriptionGrantSchema.index({ actorId: 1, requestKey: 1 }, { unique: true });
SubscriptionGrantSchema.index({ userId: 1, createdAt: -1, _id: -1 });
