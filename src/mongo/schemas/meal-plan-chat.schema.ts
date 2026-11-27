import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema, onDelete } from './common.js';
import { Identified } from './identified.js';

export type MealPlanChatProposalStatus = 'staged' | 'saved' | 'dismissed';

@Schema(collectionSchema('meal_plan_chat_threads'))
export class MealPlanChatThread extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true, default: 'Cuộc trò chuyện mới' })
  title!: string;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  sequence!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  messageCount!: number;

  @Prop({ type: Date, required: true, default: () => new Date() })
  lastMessageAt!: Date;

  @Prop({ type: String, default: null })
  lastMessagePreview!: string | null;

  @Prop({ type: Object, required: true, default: () => ({}) })
  proposalStatuses!: Record<string, MealPlanChatProposalStatus>;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const MealPlanChatThreadSchema =
  SchemaFactory.createForClass(MealPlanChatThread);
MealPlanChatThreadSchema.index({ userId: 1, lastMessageAt: -1, _id: -1 });
onDelete(MealPlanChatThreadSchema, async (db, ids, session) => {
  await db
    .model('MealPlanChatMessage')
    .deleteMany({ threadId: { $in: ids } }, { session });
});

@Schema({ ...collectionSchema('meal_plan_chat_messages'), minimize: false })
export class MealPlanChatMessage extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  threadId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  messageId!: string;

  @Prop({ type: Number, required: true, min: 1 })
  sequence!: number;

  @Prop({ type: String, required: true, enum: ['user', 'assistant'] })
  role!: 'user' | 'assistant';

  @Prop({ type: String, default: '' })
  text!: string;

  @Prop({ type: [Object], required: true, default: [] })
  parts!: Record<string, unknown>[];

  @Prop({ type: Object, default: null })
  metadata!: { refused?: boolean } | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const MealPlanChatMessageSchema =
  SchemaFactory.createForClass(MealPlanChatMessage);
MealPlanChatMessageSchema.index({ threadId: 1, sequence: 1 }, { unique: true });
MealPlanChatMessageSchema.index(
  { threadId: 1, messageId: 1 },
  { unique: true },
);
MealPlanChatMessageSchema.index({ userId: 1, threadId: 1 });
