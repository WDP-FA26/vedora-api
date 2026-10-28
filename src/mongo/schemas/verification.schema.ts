import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { VerificationStatus } from '../enums';
import { collectionSchema, indexName } from './common';
import { Identified } from './user.schema';

@Schema(collectionSchema('verification_requests'))
export class VerificationRequest extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  statement!: string;

  @Prop({
    type: String,
    enum: Object.values(VerificationStatus),
    required: true,
    default: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @Prop({ type: String, default: null })
  reviewNote!: string | null;

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const VerificationRequestSchema =
  SchemaFactory.createForClass(VerificationRequest);
VerificationRequestSchema.index(
  { status: 1, createdAt: 1 },
  { name: indexName('verification_requests', ['status', 'createdAt'], 'idx') },
);
VerificationRequestSchema.index(
  { userId: 1, createdAt: 1 },
  { name: indexName('verification_requests', ['userId', 'createdAt'], 'idx') },
);

@Schema(collectionSchema('verification_proofs', 'created'))
export class VerificationProof extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  ownerId!: string | null;

  @Prop({ type: String, default: null })
  requestId!: string | null;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const VerificationProofSchema =
  SchemaFactory.createForClass(VerificationProof);
VerificationProofSchema.index(
  { storageKey: 1 },
  {
    unique: true,
    name: indexName('verification_proofs', ['storageKey'], 'key'),
  },
);
VerificationProofSchema.index(
  { ownerId: 1, requestId: 1 },
  { name: indexName('verification_proofs', ['ownerId', 'requestId'], 'idx') },
);
VerificationProofSchema.index(
  { requestId: 1, createdAt: 1 },
  { name: indexName('verification_proofs', ['requestId', 'createdAt'], 'idx') },
);
