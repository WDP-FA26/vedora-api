import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('ai_cost_calls'))
export class AiCostCall extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true }) turnId!: string;
  @Prop({ type: String, required: true }) executionId!: string;
  @Prop({ type: String, default: null }) userId!: string | null;
  @Prop({ type: String, required: true }) feature!: string;
  @Prop({ type: String, required: true }) operation!: string;
  @Prop({ type: String, default: 'unknown' }) requestedModel!: string;
  @Prop({ type: String, default: null }) resolvedModel!: string | null;
  @Prop({ type: String, default: null }) provider!: string | null;
  @Prop({ type: String, default: null }) generationId!: string | null;
  @Prop({ type: String }) chargeKey?: string;
  @Prop({ type: Boolean, default: false }) duplicateCharge!: boolean;
  @Prop({ type: MongooseSchema.Types.Decimal128, default: null })
  costUsd!: Types.Decimal128 | null;
  @Prop({ type: String, enum: ['RESPONSE', 'GENERATION'], default: null })
  costSource!: 'RESPONSE' | 'GENERATION' | null;
  @Prop({ type: Number, default: null }) inputTokens!: number | null;
  @Prop({ type: Number, default: null }) outputTokens!: number | null;
  @Prop({ type: Number, default: null }) reasoningTokens!: number | null;
  @Prop({ type: Number, default: null }) cachedTokens!: number | null;
  @Prop({
    type: String,
    enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'ABORTED'],
    default: 'PENDING',
  })
  status!: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';
  @Prop({ type: Number, default: null }) httpStatus!: number | null;
  @Prop({ type: Date, default: Date.now }) startedAt!: Date;
  @Prop({ type: Date, default: null }) finishedAt!: Date | null;
  @Prop({ type: Date, default: null }) reconciledAt!: Date | null;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const AiCostCallSchema = SchemaFactory.createForClass(AiCostCall);
AiCostCallSchema.index({ startedAt: -1, _id: -1 });
AiCostCallSchema.index({ feature: 1, startedAt: -1 });
AiCostCallSchema.index({ turnId: 1, startedAt: 1 });
AiCostCallSchema.index({ chargeKey: 1 }, { unique: true, sparse: true });
