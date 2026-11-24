import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('post_report_evidence', 'created'))
export class PostReportEvidence extends Identified {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ type: String, required: true }) ownerId!: string;
  @Prop({ type: String, required: true }) postId!: string;
  @Prop({ type: String, default: null }) reportId!: string | null;
  @Prop({ type: String, required: true }) storageKey!: string;
  @Prop({ type: String, required: true }) contentType!: string;
  @Prop({ type: Number, required: true }) sizeBytes!: number;
  @Prop({ type: Date }) createdAt!: Date;
}
export const PostReportEvidenceSchema =
  SchemaFactory.createForClass(PostReportEvidence);
PostReportEvidenceSchema.index({ reportId: 1, createdAt: 1 });
PostReportEvidenceSchema.index({ ownerId: 1, reportId: 1 });
