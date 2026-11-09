import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ProfileImageKind, ProfileImageStatus } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('profile_image_uploads', 'created'))
export class ProfileImageUpload extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  ownerId!: string | null;

  @Prop({ type: String, enum: Object.values(ProfileImageKind), required: true })
  kind!: ProfileImageKind;

  @Prop({
    type: String,
    enum: Object.values(ProfileImageStatus),
    required: true,
    default: ProfileImageStatus.WAITING_UPLOAD,
  })
  status!: ProfileImageStatus;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const ProfileImageUploadSchema =
  SchemaFactory.createForClass(ProfileImageUpload);
ProfileImageUploadSchema.index({ storageKey: 1 }, { unique: true });
ProfileImageUploadSchema.index({ ownerId: 1, status: 1 });
ProfileImageUploadSchema.index({ status: 1, createdAt: 1 });
