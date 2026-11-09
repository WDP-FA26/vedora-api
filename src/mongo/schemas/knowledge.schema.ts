import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('knowledge_documents'))
export class KnowledgeDocument extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  uploadedById!: string | null;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, required: true })
  contentType!: string;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: Number, default: null })
  sizeBytes!: number | null;

  @Prop({
    type: String,
    enum: Object.values(KnowledgeDocumentStatus),
    required: true,
    default: KnowledgeDocumentStatus.WAITING_UPLOAD,
  })
  status!: KnowledgeDocumentStatus;

  @Prop({
    type: String,
    enum: Object.values(KnowledgeDocumentFailureReason),
    default: null,
  })
  failureReason!: KnowledgeDocumentFailureReason | null;

  @Prop({ type: Number, default: null })
  sectionCount!: number | null;

  @Prop({ type: Number, default: null })
  imageCount!: number | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const KnowledgeDocumentSchema =
  SchemaFactory.createForClass(KnowledgeDocument);
KnowledgeDocumentSchema.index({ storageKey: 1 }, { unique: true });
KnowledgeDocumentSchema.index({ status: 1, updatedAt: 1 });
