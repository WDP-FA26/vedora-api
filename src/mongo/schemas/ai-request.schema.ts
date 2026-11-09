import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AiFeature } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('ai_requests'))
export class AiRequest extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true }) userId!: string;
  @Prop({ type: String, required: true }) requestKey!: string;
  @Prop({ type: String, enum: Object.values(AiFeature), required: true })
  feature!: AiFeature;
  @Prop({ type: String, enum: ['TEXT', 'IMAGE'], required: true }) bucket!:
    'TEXT' | 'IMAGE';
  @Prop({ type: String, required: true }) periodKey!: string;
  @Prop({ type: String, required: true }) promptHash!: string;
  @Prop({ type: [String], default: [] }) requestHashes!: string[];
  @Prop({ type: Boolean, default: false }) charged!: boolean;
  @Prop({
    type: String,
    enum: ['RESERVED', 'COMPLETED', 'REFUNDED'],
    required: true,
  })
  status!: 'RESERVED' | 'COMPLETED' | 'REFUNDED';
  @Prop({ type: String, default: null }) leaseToken!: string | null;
  @Prop({ type: String, default: null }) activeHash!: string | null;
  @Prop({ type: Date, default: null }) leaseUntil!: Date | null;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const AiRequestSchema = SchemaFactory.createForClass(AiRequest);
AiRequestSchema.index(
  { userId: 1, feature: 1, requestKey: 1 },
  { unique: true },
);
AiRequestSchema.index({
  userId: 1,
  periodKey: 1,
  bucket: 1,
  charged: 1,
  status: 1,
  leaseUntil: 1,
});
