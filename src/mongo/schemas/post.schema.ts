import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  PostRemovalActor,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
} from '../enums.js';
import { cascadeOnDelete, collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema({ _id: false })
export class Blog {
  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  coverImageUrl!: string | null;

  @Prop({ type: String, default: '' })
  content!: string;

  @Prop({ type: String, default: '' })
  excerpt!: string;

  @Prop({ type: [String], required: true, default: [] })
  recipeIds!: string[];
}

export const BlogSchema = SchemaFactory.createForClass(Blog);

export const EVIDENCE_STATUSES = ['READY', 'FAILED', 'REFUSED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_FIELDS = [
  'body',
  'title',
  'content',
  'transcript',
  'frame',
  'image',
] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** One part of a post that the reviewer model says breaks the policy. */
@Schema({ _id: false })
export class ModerationEvidenceItem {
  @Prop({ type: String, enum: EVIDENCE_FIELDS, required: true })
  field!: EvidenceField;

  @Prop({ type: String, required: true })
  category!: string;

  @Prop({ type: String, required: true })
  reason!: string;

  /** Text fields: the exact substring. Frames and images: text the model read in it (OCR, may be off). */
  @Prop({ type: String, default: null })
  quote!: string | null;

  /** Offset of `quote` in the field (UTF-16 code units, after NFC). Text fields only. */
  @Prop({ type: Number, default: null })
  start!: number | null;

  @Prop({ type: Number, default: null })
  end!: number | null;

  @Prop({ type: String, default: null })
  mediaId!: string | null;

  @Prop({ type: Number, default: null })
  seconds!: number | null;

  @Prop({ type: String, default: null })
  imageUrl!: string | null;
}

export const ModerationEvidenceItemSchema = SchemaFactory.createForClass(
  ModerationEvidenceItem,
);

@Schema({ _id: false })
export class ModerationEvidence {
  @Prop({ type: String, enum: EVIDENCE_STATUSES, required: true })
  status!: EvidenceStatus;

  /** Why the content got its risk level, in Vietnamese: null unless READY. */
  @Prop({ type: String, default: null })
  summary!: string | null;

  @Prop({ type: [ModerationEvidenceItemSchema], default: [] })
  items!: ModerationEvidenceItem[];

  /** Model quotes that did not match the post, so were dropped. */
  @Prop({ type: Number, default: 0 })
  dropped!: number;

  @Prop({ type: String, required: true })
  model!: string;

  @Prop({ type: Date, required: true })
  createdAt!: Date;
}

export const ModerationEvidenceSchema =
  SchemaFactory.createForClass(ModerationEvidence);

@Schema({ _id: false })
export class PostModeration {
  @Prop({ type: String, required: true })
  verdict!: string;

  /** 0 (no risk) to 3 (a clear violation); null when the model gave none or on posts judged before risk levels. */
  @Prop({ type: Number, default: null })
  riskLevel!: number | null;

  @Prop({ type: Date, required: true })
  checkedAt!: Date;

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: String, default: null })
  reviewNote!: string | null;

  /** Admin-only explanation of the verdict, from the same model call. */
  @Prop({ type: ModerationEvidenceSchema, default: null })
  evidence?: ModerationEvidence | null;
}

export const PostModerationSchema =
  SchemaFactory.createForClass(PostModeration);

@Schema({ _id: false })
export class PostRemoval {
  @Prop({ type: String, required: true })
  removedById!: string;

  @Prop({
    type: String,
    enum: Object.values(PostRemovalActor),
    required: true,
  })
  removedByRole!: PostRemovalActor;

  @Prop({ type: Date, required: true })
  removedAt!: Date;

  @Prop({
    type: String,
    enum: Object.values(PostStatus),
    required: true,
  })
  previousStatus!: PostStatus;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: String, default: null })
  restoredById!: string | null;

  @Prop({ type: Date, default: null })
  restoredAt!: Date | null;
}

export const PostRemovalSchema = SchemaFactory.createForClass(PostRemoval);

@Schema(collectionSchema('posts'))
export class Post extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({
    type: String,
    enum: Object.values(PostType),
    required: true,
    default: PostType.POST,
  })
  type!: PostType;

  @Prop({
    type: String,
    enum: Object.values(PostStatus),
    required: true,
    default: PostStatus.PROCESSING,
  })
  status!: PostStatus;

  @Prop({ type: String, default: null })
  body!: string | null;

  @Prop({ type: String, enum: ['POST', 'VIDEO', null], default: null })
  draftKind!: 'POST' | 'VIDEO' | null;

  @Prop({ type: String, default: '' })
  draftTitle!: string;

  @Prop({ type: String, default: '' })
  draftDescription!: string;

  @Prop({ type: Number, default: 0 })
  draftVersion!: number;

  /** Serializes comment writes with post deletion without changing its public edit time. */
  @Prop({ type: Number, default: 0 })
  commentRevision!: number;

  @Prop({ type: BlogSchema, default: null })
  blog!: Blog | null;

  @Prop({ type: PostModerationSchema, default: null })
  moderation!: PostModeration | null;

  @Prop({ type: PostRemovalSchema, default: null })
  removal?: PostRemoval | null;

  @Prop({ type: Date, default: null })
  searchIndexedAt!: Date | null;

  @Prop({ type: Number, required: true, default: 0 })
  viewCount!: number;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PostSchema = SchemaFactory.createForClass(Post);
PostSchema.index({ status: 1, publishedAt: 1 });
PostSchema.index({ authorId: 1, createdAt: 1 });
PostSchema.index({ 'blog.recipeIds': 1 });

cascadeOnDelete(PostSchema, [
  { model: 'Notification', field: 'postId', action: 'delete' },
  { model: 'PostComment', field: 'postId', action: 'delete' },
  { model: 'PostLike', field: 'postId', action: 'delete' },
  { model: 'PostRepost', field: 'postId', action: 'delete' },
  { model: 'PostBookmark', field: 'postId', action: 'delete' },
  { model: 'PostReport', field: 'postId', action: 'delete' },
  { model: 'PostViewDay', field: 'postId', action: 'delete' },
  { model: 'PostSummary', field: 'postId', action: 'delete' },
  { model: 'MediaAsset', field: 'postId', action: 'unset' },
  { model: 'Recipe', field: 'postId', action: 'unset' },
]);

@Schema(collectionSchema('post_comments'))
export class PostComment extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({ type: String, default: null })
  parentId!: string | null;

  @Prop({ type: String, default: null })
  replyToId!: string | null;

  /** A write fence for concurrent replies and parent/target deletion. */
  @Prop({ type: Number, default: 0 })
  threadRevision!: number;

  @Prop({ type: String, required: true })
  body!: string;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PostCommentSchema = SchemaFactory.createForClass(PostComment);
PostCommentSchema.index({ postId: 1, createdAt: 1, _id: 1 });
PostCommentSchema.index({ authorId: 1 });
PostCommentSchema.index({ postId: 1, parentId: 1, createdAt: -1, _id: -1 });
PostCommentSchema.index({ parentId: 1 });
PostCommentSchema.index({ replyToId: 1 });
cascadeOnDelete(PostCommentSchema, [
  { model: 'PostComment', field: 'parentId', action: 'delete' },
  { model: 'PostComment', field: 'replyToId', action: 'unset' },
  { model: 'Notification', field: 'commentId', action: 'delete' },
  { model: 'PostSummary', field: 'commentId', action: 'unset' },
]);

@Schema(collectionSchema('post_likes', 'created'))
export class PostLike extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostLikeSchema = SchemaFactory.createForClass(PostLike);
PostLikeSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostLikeSchema.index({ userId: 1 });

@Schema(collectionSchema('post_reposts', 'created'))
export class PostRepost extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostRepostSchema = SchemaFactory.createForClass(PostRepost);
PostRepostSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostRepostSchema.index({ userId: 1, createdAt: 1 });

@Schema(collectionSchema('post_bookmarks', 'created'))
export class PostBookmark extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostBookmarkSchema = SchemaFactory.createForClass(PostBookmark);
PostBookmarkSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostBookmarkSchema.index({ userId: 1, createdAt: 1 });

@Schema(collectionSchema('post_reports', 'created'))
export class PostReport extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  reporterId!: string;

  @Prop({ type: String, enum: Object.values(PostReportReason), required: true })
  reason!: PostReportReason;

  @Prop({ type: String, default: null })
  details!: string | null;

  @Prop({
    type: String,
    enum: Object.values(PostReportStatus),
    required: true,
    default: PostReportStatus.PENDING,
  })
  status!: PostReportStatus;

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostReportSchema = SchemaFactory.createForClass(PostReport);
PostReportSchema.index({ postId: 1, reporterId: 1 }, { unique: true });
PostReportSchema.index({ status: 1, createdAt: 1 });

/**
 * Views of one published post on one app-time-zone calendar day, rolled up by
 * PostViewsService. Counts start when this collection was introduced; earlier
 * views exist only in `Post.viewCount`.
 */
@Schema(collectionSchema('post_view_days', 'none'))
export class PostViewDay extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  /** `YYYY-MM-DD` in APP_TIMEZONE. */
  @Prop({ type: String, required: true })
  date!: string;

  @Prop({ type: Number, required: true, default: 0 })
  count!: number;
}

export const PostViewDaySchema = SchemaFactory.createForClass(PostViewDay);
PostViewDaySchema.index({ postId: 1, date: 1 }, { unique: true });
PostViewDaySchema.index({ authorId: 1, date: 1 });
PostViewDaySchema.index({ date: 1 });
