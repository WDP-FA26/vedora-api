import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BillingPlan } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema({ _id: false })
export class SubscriptionPlanLimits {
  @Prop({ type: Number, required: true, min: 0 }) textLimit!: number;
  @Prop({ type: Number, required: true, min: 0 }) imageLimit!: number;
}
const LimitsSchema = SchemaFactory.createForClass(SubscriptionPlanLimits);

@Schema({ _id: false })
export class SubscriptionCatalogPlan extends SubscriptionPlanLimits {
  @Prop({
    type: String,
    required: true,
    enum: [BillingPlan.PLUS, BillingPlan.PRO],
  })
  code!: BillingPlan;
  @Prop({ type: Number, required: true, min: 1 }) priceVnd!: number;
}
const PlanSchema = SchemaFactory.createForClass(SubscriptionCatalogPlan);

@Schema(collectionSchema('subscription_catalogs'))
export class SubscriptionCatalog extends Identified {
  @Prop({ type: String }) _id!: string;
  @Prop({ type: Number, required: true }) version!: number;
  @Prop({ type: LimitsSchema, required: true })
  freeLimits!: SubscriptionPlanLimits;
  @Prop({ type: [PlanSchema], required: true })
  plans!: SubscriptionCatalogPlan[];
  @Prop({ type: String, required: true }) updatedById!: string;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const SubscriptionCatalogSchema =
  SchemaFactory.createForClass(SubscriptionCatalog);
