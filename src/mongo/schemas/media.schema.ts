import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  CaptionStatus,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  MediaFailureReason,
  MediaStatus,
  MediaType,
} from '../enums';
import { collectionSchema, indexName } from './common';
import { Identified } from './user.schema';

/** One WebVTT track of a video, embedded in the asset. */
@Schema({ _id: false })
export class MediaCaption {
  @Prop({ type: String, required: true })
  languageCode!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: Boolean, required: true })
  isOriginal!: boolean;

  @Prop({ type: String, required: true })
  url!: string;
}

export const MediaCaptionSchema = SchemaFactory.createForClass(MediaCaption);

@Schema(collectionSchema('media_assets'))
export class MediaAsset extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  ownerId!: string | null;

  @Prop({ type: String, enum: Object.values(MediaType), required: true })
  type!: MediaType;

  @Prop({
    type: String,
    enum: Object.values(MediaStatus),
    required: true,
    default: MediaStatus.WAITING_UPLOAD,
  })
  status!: MediaStatus;

  @Prop({
    type: String,
    enum: Object.values(MediaFailureReason),
    default: null,
  })
  failureReason!: MediaFailureReason | null;

  @Prop({ type: String, default: null })
  postId!: string | null;

  @Prop({ type: Number, required: true, default: 0 })
  position!: number;

  @Prop({ type: String, required: true })
  publicId!: string;

  @Prop({ type: Number, default: null })
  durationSec!: number | null;

  @Prop({ type: String, default: null })
  aspectRatio!: string | null;

  @Prop({
    type: String,
    enum: Object.values(CaptionStatus),
    required: true,
    default: CaptionStatus.NONE,
  })
  captionStatus!: CaptionStatus;

  @Prop({ type: String, default: null })
  captionLanguage!: string | null;

  @Prop({ type: String, default: null })
  transcript!: string | null;

  @Prop({ type: Date, default: null })
  discardedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;

  @Prop({ type: [MediaCaptionSchema], required: true, default: [] })
  captions!: MediaCaption[];
}

export const MediaAssetSchema = SchemaFactory.createForClass(MediaAsset);
MediaAssetSchema.index(
  { publicId: 1 },
  { unique: true, name: indexName('media_assets', ['publicId'], 'key') },
);
MediaAssetSchema.index(
  { ownerId: 1, status: 1 },
  { name: indexName('media_assets', ['ownerId', 'status'], 'idx') },
);
MediaAssetSchema.index(
  { postId: 1 },
  { name: indexName('media_assets', ['postId'], 'idx') },
);
MediaAssetSchema.index(
  { status: 1, updatedAt: 1 },
  { name: indexName('media_assets', ['status', 'updatedAt'], 'idx') },
);
MediaAssetSchema.index(
  { discardedAt: 1 },
  { name: indexName('media_assets', ['discardedAt'], 'idx') },
);
MediaAssetSchema.index(
  { captionStatus: 1, updatedAt: 1 },
  { name: indexName('media_assets', ['captionStatus', 'updatedAt'], 'idx') },
);

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
KnowledgeDocumentSchema.index(
  { storageKey: 1 },
  {
    unique: true,
    name: indexName('knowledge_documents', ['storageKey'], 'key'),
  },
);
KnowledgeDocumentSchema.index(
  { status: 1, updatedAt: 1 },
  { name: indexName('knowledge_documents', ['status', 'updatedAt'], 'idx') },
);
