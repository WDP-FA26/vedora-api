import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AiFeature } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

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
AiUsageSchema.index({ userId: 1, day: 1, feature: 1 }, { unique: true });
