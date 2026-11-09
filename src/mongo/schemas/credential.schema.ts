import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { OneTimeCodePurpose } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('refresh_tokens', 'created'))
export class RefreshToken extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  familyId!: string;

  @Prop({ type: String, required: true })
  tokenHash!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
RefreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index({ userId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 });

@Schema(collectionSchema('one_time_codes', 'none'))
export class OneTimeCode extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({
    type: String,
    enum: Object.values(OneTimeCodePurpose),
    required: true,
  })
  purpose!: OneTimeCodePurpose;

  @Prop({ type: String, required: true })
  codeHash!: string;

  @Prop({ type: Number, required: true, default: 0 })
  attempts!: number;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, required: true })
  sentAt!: Date;

  @Prop({ type: Date, required: true })
  firstSentAt!: Date;

  @Prop({ type: Number, required: true, default: 0 })
  resendCount!: number;
}

export const OneTimeCodeSchema = SchemaFactory.createForClass(OneTimeCode);
OneTimeCodeSchema.index({ userId: 1, purpose: 1 }, { unique: true });

@Schema(collectionSchema('email_verification_guesses', 'none'))
export class EmailVerificationGuesses {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: Number, required: true, default: 0 })
  guesses!: number;

  @Prop({ type: Date, required: true })
  windowStart!: Date;
}

export const EmailVerificationGuessesSchema = SchemaFactory.createForClass(
  EmailVerificationGuesses,
);
