import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { NotificationType } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('notifications', 'created'))
export class Notification extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  recipientId!: string;

  @Prop({ type: String, default: null })
  actorId!: string | null;

  @Prop({ type: String, enum: Object.values(NotificationType), required: true })
  type!: NotificationType;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: String, default: null })
  note!: string | null;

  @Prop({ type: String, default: null })
  postId!: string | null;

  @Prop({ type: String, default: null })
  commentId!: string | null;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ recipientId: 1, createdAt: 1, _id: 1 });
NotificationSchema.index({ recipientId: 1, readAt: 1 });
NotificationSchema.index({ postId: 1 });
