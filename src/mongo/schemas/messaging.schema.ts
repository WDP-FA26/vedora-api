import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema, onDelete } from './common.js';
import { Identified } from './user.schema.js';

export enum MessagingEventType {
  MESSAGE_CREATED = 'message.created',
  CONVERSATION_READ = 'conversation.read',
  RELATIONSHIP_CHANGED = 'relationship.changed',
}

@Schema(collectionSchema('conversations'))
export class Conversation extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  /** Participants are ordered lexically, so one pair has one conversation. */
  @Prop({ type: String, required: true })
  lowId!: string;

  @Prop({ type: String, required: true })
  highId!: string;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  sequence!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  lowReadSequence!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  highReadSequence!: number;

  @Prop({ type: Date, default: null })
  lastMessageAt!: Date | null;

  @Prop({ type: String, default: null })
  lastMessageId!: string | null;

  @Prop({ type: String, default: null })
  lastSenderId!: string | null;

  @Prop({ type: String, default: null, maxlength: 2000 })
  lastMessageBody!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
ConversationSchema.index({ lowId: 1, highId: 1 }, { unique: true });
ConversationSchema.index({ lowId: 1, lastMessageAt: -1, _id: -1 });
ConversationSchema.index({ highId: 1, lastMessageAt: -1, _id: -1 });
onDelete(ConversationSchema, async (db, ids, session) => {
  await db
    .model('DirectMessage')
    .deleteMany({ conversationId: { $in: ids } }, { session });
  await db
    .model('MessagingEvent')
    .deleteMany({ conversationId: { $in: ids } }, { session });
});

@Schema(collectionSchema('direct_messages', 'created'))
export class DirectMessage extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  conversationId!: string;

  @Prop({ type: String, required: true })
  senderId!: string;

  @Prop({ type: String, required: true })
  recipientId!: string;

  @Prop({ type: String, required: true })
  clientMessageId!: string;

  @Prop({ type: Number, required: true, min: 1 })
  sequence!: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 2000 })
  body!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const DirectMessageSchema = SchemaFactory.createForClass(DirectMessage);
DirectMessageSchema.index(
  { conversationId: 1, sequence: -1 },
  { unique: true },
);
DirectMessageSchema.index(
  { conversationId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true },
);
DirectMessageSchema.index({ conversationId: 1, recipientId: 1, sequence: 1 });

/** Transactional outbox. Only committed invalidations are streamed, never message bodies. */
@Schema(collectionSchema('messaging_events', 'created'))
export class MessagingEvent extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: [String], required: true })
  userIds!: string[];

  @Prop({
    type: String,
    required: true,
    enum: Object.values(MessagingEventType),
  })
  type!: MessagingEventType;

  @Prop({ type: String, default: null })
  conversationId!: string | null;

  @Prop({ type: String, default: null })
  messageId!: string | null;

  @Prop({ type: String, default: null })
  readerId!: string | null;

  @Prop({ type: Number, default: null })
  readSequence!: number | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const MessagingEventSchema =
  SchemaFactory.createForClass(MessagingEvent);
MessagingEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);
