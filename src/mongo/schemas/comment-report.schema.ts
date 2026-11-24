import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PostReportReason, PostReportStatus } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

export const COMMENT_REPORT_ACTIONS = [
  'DISMISSED',
  'REMOVED',
  'ALREADY_REMOVED',
] as const;
export type CommentReportAction = (typeof COMMENT_REPORT_ACTIONS)[number];

@Schema({ _id: false })
export class ReportedCommentAuthor {
  @Prop({ type: String, required: true }) id!: string;
  @Prop({ type: String, required: true }) username!: string;
  @Prop({ type: String, required: true }) fullName!: string;
  @Prop({ type: String, default: null }) avatarUrl!: string | null;
  @Prop({ type: Boolean, default: false }) isProfessional!: boolean;
}
const ReportedCommentAuthorSchema = SchemaFactory.createForClass(
  ReportedCommentAuthor,
);

/** Evidence survives comment edits/deletion; only admins can read the snapshots. */
@Schema(collectionSchema('comment_reports'))
export class CommentReport extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true }) postId!: string;
  @Prop({ type: String, required: true }) commentId!: string;
  @Prop({ type: String, default: null }) parentId!: string | null;
  @Prop({ type: String, required: true }) reporterId!: string;
  @Prop({ type: String, enum: Object.values(PostReportReason), required: true })
  reason!: PostReportReason;
  @Prop({ type: String, default: null }) details!: string | null;
  @Prop({ type: String, required: true }) bodySnapshot!: string;
  @Prop({ type: ReportedCommentAuthorSchema, required: true })
  authorSnapshot!: ReportedCommentAuthor;
  @Prop({
    type: String,
    enum: Object.values(PostReportStatus),
    default: PostReportStatus.PENDING,
  })
  status!: PostReportStatus;
  @Prop({ type: String, enum: COMMENT_REPORT_ACTIONS, default: null })
  action!: CommentReportAction | null;
  @Prop({ type: String, default: null }) reviewedById!: string | null;
  @Prop({ type: Date, default: null }) reviewedAt!: Date | null;
  @Prop({ type: Date }) createdAt!: Date;
  @Prop({ type: Date }) updatedAt!: Date;
}
export const CommentReportSchema = SchemaFactory.createForClass(CommentReport);
CommentReportSchema.index({ commentId: 1, reporterId: 1 }, { unique: true });
CommentReportSchema.index({ status: 1, createdAt: -1, _id: -1 });
CommentReportSchema.index({ postId: 1, commentId: 1 });
