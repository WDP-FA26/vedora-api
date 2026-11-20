import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AppealOutcome,
  AppealReasonCategory,
  PostType,
  SupportMessageKind,
  SupportSenderRole,
  SupportTicketCategory,
  SupportTicketStatus,
} from '../enums.js';
import {
  ROUTE_APPLIERS,
  ROUTE_RULES,
  type RouteApplier,
  type RouteRule,
} from './post.schema.js';
import { cascadeOnDelete, collectionSchema } from './common.js';
import { Identified } from './identified.js';

export const APPEAL_TRIGGER_STATUSES = ['REJECTED', 'REMOVED'] as const;
export type AppealTriggerStatus = (typeof APPEAL_TRIGGER_STATUSES)[number];

@Schema({ _id: false })
export class AppealPostSnapshot {
  @Prop({ type: String, default: null })
  title!: string | null;

  @Prop({ type: String, default: null })
  excerpt!: string | null;

  @Prop({ type: String, default: null })
  verdict!: string | null;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: String, enum: [...ROUTE_RULES, null], default: null })
  routeRule!: RouteRule | null;

  @Prop({ type: String, enum: [...ROUTE_APPLIERS, null], default: null })
  routeAppliedBy!: RouteApplier | null;

  @Prop({ type: String, default: null })
  routeCategory!: string | null;

  @Prop({ type: Date, required: true })
  blockedAt!: Date;
}

export const AppealPostSnapshotSchema =
  SchemaFactory.createForClass(AppealPostSnapshot);

@Schema({ _id: false })
export class SupportAppealData {
  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, enum: Object.values(PostType), required: true })
  postType!: PostType;

  @Prop({ type: String, enum: APPEAL_TRIGGER_STATUSES, required: true })
  triggerStatus!: AppealTriggerStatus;

  /** Identifies the specific moderation rejection or admin removal incident. */
  @Prop({ type: String, required: true })
  incidentKey!: string;

  @Prop({
    type: String,
    enum: Object.values(AppealReasonCategory),
    required: true,
    default: AppealReasonCategory.OTHER,
  })
  reasonCategory!: AppealReasonCategory;

  @Prop({
    type: String,
    enum: [...Object.values(AppealOutcome), null],
    default: null,
  })
  outcome!: AppealOutcome | null;

  @Prop({ type: AppealPostSnapshotSchema, required: true })
  postSnapshot!: AppealPostSnapshot;
}

export const SupportAppealDataSchema =
  SchemaFactory.createForClass(SupportAppealData);

@Schema(collectionSchema('support_tickets'))
export class SupportTicket extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  code!: string;

  @Prop({
    type: String,
    enum: Object.values(SupportTicketCategory),
    required: true,
  })
  category!: SupportTicketCategory;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({ type: String, required: true })
  subject!: string;

  @Prop({
    type: String,
    enum: Object.values(SupportTicketStatus),
    required: true,
    default: SupportTicketStatus.OPEN,
  })
  status!: SupportTicketStatus;

  /** Populated only when category === CONTENT_APPEAL. */
  @Prop({ type: SupportAppealDataSchema, default: null })
  appeal!: SupportAppealData | null;

  /** Optional reference code (e.g. SePay payment transfer code) for non-appeal tickets. */
  @Prop({ type: String, default: null })
  referenceCode!: string | null;

  @Prop({ type: Date, required: true })
  lastMessageAt!: Date;

  @Prop({
    type: String,
    enum: Object.values(SupportSenderRole),
    required: true,
    default: SupportSenderRole.USER,
  })
  lastMessageByRole!: SupportSenderRole;

  @Prop({ type: Number, required: true, default: 1 })
  messageCount!: number;

  /** Set when status becomes WAITING_USER; used to auto-expire stale tickets. */
  @Prop({ type: Date, default: null })
  waitingUserSince!: Date | null;

  /**
   * Reminders sent during the current WAITING_USER stretch (0, 1 or 2). Like
   * Zendesk's "bump bump solve", a ticket only expires after the final one,
   * and every reply from either side starts the count again.
   */
  @Prop({ type: Number, default: 0 })
  waitingReminderCount!: number;

  @Prop({ type: Date, default: null })
  lastReminderAt!: Date | null;

  /** The admin who claimed the ticket; only they may reply publicly or resolve it. */
  @Prop({ type: String, default: null })
  assigneeId!: string | null;

  @Prop({ type: Date, default: null })
  assignedAt!: Date | null;

  @Prop({ type: String, default: null })
  resolvedById!: string | null;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: String, default: null })
  resolutionNote!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);

SupportTicketSchema.index({ code: 1 }, { unique: true });
SupportTicketSchema.index(
  { 'appeal.postId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      category: SupportTicketCategory.CONTENT_APPEAL,
      status: {
        $in: [SupportTicketStatus.OPEN, SupportTicketStatus.WAITING_USER],
      },
    },
  },
);
SupportTicketSchema.index(
  { 'appeal.postId': 1, 'appeal.incidentKey': 1 },
  {
    unique: true,
    partialFilterExpression: {
      category: SupportTicketCategory.CONTENT_APPEAL,
      status: {
        $in: [
          SupportTicketStatus.OPEN,
          SupportTicketStatus.WAITING_USER,
          SupportTicketStatus.RESOLVED,
          SupportTicketStatus.CLOSED,
          SupportTicketStatus.EXPIRED,
        ],
      },
    },
  },
);
SupportTicketSchema.index({ authorId: 1, updatedAt: -1, _id: -1 });
SupportTicketSchema.index({ status: 1, lastMessageAt: 1, _id: 1 });
SupportTicketSchema.index({ category: 1, status: 1, lastMessageAt: 1, _id: 1 });
SupportTicketSchema.index({ status: 1, waitingUserSince: 1 });
SupportTicketSchema.index({
  assigneeId: 1,
  status: 1,
  lastMessageAt: 1,
  _id: 1,
});
SupportTicketSchema.index({ 'appeal.postId': 1, createdAt: -1, _id: -1 });

cascadeOnDelete(SupportTicketSchema, [
  { model: 'SupportMessage', field: 'ticketId', action: 'delete' },
]);

@Schema(collectionSchema('support_messages', 'created'))
export class SupportMessage extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  ticketId!: string;

  @Prop({ type: String, default: null })
  senderId!: string | null;

  @Prop({
    type: String,
    enum: Object.values(SupportSenderRole),
    required: true,
  })
  senderRole!: SupportSenderRole;

  @Prop({
    type: String,
    enum: Object.values(SupportMessageKind),
    required: true,
    default: SupportMessageKind.MESSAGE,
  })
  kind!: SupportMessageKind;

  @Prop({ type: Boolean, required: true, default: false })
  isInternal!: boolean;

  /** Empty when the message carries only attachments. */
  @Prop({ type: String, default: '' })
  body!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const SupportMessageSchema =
  SchemaFactory.createForClass(SupportMessage);
SupportMessageSchema.index({ ticketId: 1, createdAt: 1, _id: 1 });

cascadeOnDelete(SupportMessageSchema, [
  { model: 'SupportAttachment', field: 'messageId', action: 'delete' },
]);

/**
 * An image uploaded to the private support bucket. It stays unattached
 * (`messageId: null`) until a message claims it; stale unattached uploads are purged.
 */
@Schema(collectionSchema('support_attachments', 'created'))
export class SupportAttachment extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  ownerId!: string;

  @Prop({ type: String, default: null })
  ticketId!: string | null;

  @Prop({ type: String, default: null })
  messageId!: string | null;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: String, required: true })
  contentType!: string;

  @Prop({ type: Number, required: true })
  sizeBytes!: number;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const SupportAttachmentSchema =
  SchemaFactory.createForClass(SupportAttachment);
SupportAttachmentSchema.index({ storageKey: 1 }, { unique: true });
SupportAttachmentSchema.index({ ownerId: 1, messageId: 1 });
SupportAttachmentSchema.index({ messageId: 1, createdAt: 1, _id: 1 });
