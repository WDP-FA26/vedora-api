import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { FollowSuggestionReason } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('follows', 'created'))
export class Follow extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  followerId!: string;

  @Prop({ type: String, required: true })
  followingId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);
FollowSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
FollowSchema.index({ followingId: 1, createdAt: 1, followerId: 1 });
FollowSchema.index({ followerId: 1, createdAt: 1, followingId: 1 });

@Schema(collectionSchema('follow_suggestions', 'none'))
export class FollowSuggestion extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  candidateId!: string;

  @Prop({ type: Number, required: true })
  score!: number;

  @Prop({
    type: String,
    enum: Object.values(FollowSuggestionReason),
    required: true,
  })
  reason!: FollowSuggestionReason;

  @Prop({ type: Number, required: true })
  mutualCount!: number;
}

export const FollowSuggestionSchema =
  SchemaFactory.createForClass(FollowSuggestion);
FollowSuggestionSchema.index({ userId: 1, candidateId: 1 }, { unique: true });
FollowSuggestionSchema.index({ userId: 1, score: -1, candidateId: 1 });
FollowSuggestionSchema.index({ candidateId: 1 });

@Schema(collectionSchema('suggestion_dismissals', 'created'))
export class SuggestionDismissal extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  candidateId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const SuggestionDismissalSchema =
  SchemaFactory.createForClass(SuggestionDismissal);
SuggestionDismissalSchema.index(
  { userId: 1, candidateId: 1 },
  { unique: true },
);
