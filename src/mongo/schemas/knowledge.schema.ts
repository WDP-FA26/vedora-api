import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  KnowledgePageFlag,
} from '../enums.js';
import { collectionSchema, onDelete } from './common.js';
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

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: String, default: null })
  reviewNote!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const KnowledgeDocumentSchema =
  SchemaFactory.createForClass(KnowledgeDocument);
KnowledgeDocumentSchema.index({ storageKey: 1 }, { unique: true });
KnowledgeDocumentSchema.index({ status: 1, updatedAt: 1 });
onDelete(KnowledgeDocumentSchema, async (db, ids, session) => {
  await db
    .model('KnowledgePage')
    .deleteMany({ documentId: { $in: ids } }, { session });
});

/** The OCR text of one PDF page, kept until an admin approves the document. */
@Schema(collectionSchema('knowledge_pages'))
export class KnowledgePage extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  documentId!: string;

  /** 1-based page number. */
  @Prop({ type: Number, required: true })
  page!: number;

  @Prop({ type: String, default: '' })
  text!: string;

  @Prop({
    type: [String],
    enum: Object.values(KnowledgePageFlag),
    default: [],
  })
  flags!: KnowledgePageFlag[];

  @Prop({ type: Boolean, default: false })
  edited!: boolean;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const KnowledgePageSchema = SchemaFactory.createForClass(KnowledgePage);
KnowledgePageSchema.index({ documentId: 1, page: 1 }, { unique: true });
