import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

export const SYSTEM_LOG_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;
export type SystemLogOutcome = (typeof SYSTEM_LOG_OUTCOMES)[number];
export const SYSTEM_LOG_RESOURCES = [
  'USER',
  'POST',
  'COMMENT',
  'POST_REPORT',
  'COMMENT_REPORT',
  'RECIPE',
  'INGREDIENT',
  'INGREDIENT_GROUP',
  'INCOMPATIBILITY_RULE',
  'KNOWLEDGE',
  'MODERATION_SETTINGS',
  'SUBSCRIPTION_PLANS',
  'SUPPORT_TICKET',
  'VERIFICATION',
  'WORKSPACE',
  'PAYMENT',
  'AI_COST',
  'OTHER',
] as const;
export type SystemLogResource = (typeof SYSTEM_LOG_RESOURCES)[number];

@Schema(collectionSchema('system_logs', 'created'))
export class SystemLog extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true, immutable: true }) requestId!: string;
  @Prop({ type: String, required: true, immutable: true }) actorId!: string;
  @Prop({ type: String, required: true, immutable: true })
  actorUsername!: string;
  @Prop({ type: String, required: true, immutable: true }) action!: string;
  @Prop({ type: String, required: true, immutable: true }) actionLabel!: string;
  @Prop({
    type: String,
    enum: SYSTEM_LOG_RESOURCES,
    required: true,
    immutable: true,
  })
  resourceType!: SystemLogResource;
  @Prop({ type: String, default: null, immutable: true }) targetId!:
    string | null;
  @Prop({ type: String, required: true, immutable: true }) method!: string;
  @Prop({ type: String, required: true, immutable: true }) route!: string;
  @Prop({
    type: String,
    enum: SYSTEM_LOG_OUTCOMES,
    required: true,
    immutable: true,
  })
  outcome!: SystemLogOutcome;
  @Prop({ type: Number, required: true, immutable: true }) httpStatus!: number;
  @Prop({ type: String, default: null, immutable: true }) errorCode!:
    string | null;
  @Prop({ type: Number, required: true, immutable: true }) durationMs!: number;
  @Prop({ type: String, default: null, immutable: true }) decision!:
    string | null;
  @Prop({ type: String, default: null, immutable: true }) targetStatus!:
    string | null;
  @Prop({ type: String, default: null, immutable: true }) targetRole!:
    string | null;
  @Prop({ type: Date, immutable: true }) createdAt!: Date;
}

export const SystemLogSchema = SchemaFactory.createForClass(SystemLog);
SystemLogSchema.index({ requestId: 1 }, { unique: true });
SystemLogSchema.index({ createdAt: -1, _id: -1 });
SystemLogSchema.index({ actorId: 1, createdAt: -1, _id: -1 });
SystemLogSchema.index({ outcome: 1, createdAt: -1, _id: -1 });
SystemLogSchema.index({ resourceType: 1, createdAt: -1, _id: -1 });
