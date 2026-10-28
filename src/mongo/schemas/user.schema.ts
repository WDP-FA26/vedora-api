import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AccountStatus,
  FollowSuggestionReason,
  NotificationType,
  OneTimeCodePurpose,
  ProfileImageKind,
  ProfileImageStatus,
  UserAccountAction,
  UserRole,
} from '../enums.js';
import { collectionSchema, onDelete } from './common.js';

/** The string `id` a Mongoose document exposes for its stored `_id`. */
export abstract class Identified {
  id!: string;
}

@Schema(collectionSchema('users'))
export class User extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  username!: string;

  @Prop({ type: String, default: null })
  passwordHash!: string | null;

  @Prop({ type: String, default: null })
  googleId!: string | null;

  @Prop({ type: String, required: true })
  fullName!: string;

  @Prop({ type: String, required: true })
  email!: string;

  @Prop({ type: String, default: null })
  bio!: string | null;

  @Prop({ type: String, default: null })
  avatarUrl!: string | null;

  @Prop({ type: String, default: null })
  coverUrl!: string | null;

  @Prop({
    type: String,
    enum: Object.values(UserRole),
    required: true,
    default: UserRole.USER,
  })
  role!: UserRole;

  @Prop({
    type: String,
    enum: Object.values(AccountStatus),
    required: true,
    default: AccountStatus.PENDING_EMAIL,
  })
  status!: AccountStatus;

  @Prop({ type: Number, required: true, default: 0 })
  accountVersion!: number;

  @Prop({ type: Boolean, required: true, default: false })
  isProfessional!: boolean;

  @Prop({ type: Date, default: null })
  emailVerifiedAt!: Date | null;

  @Prop({ type: [String], required: true, default: [] })
  avoidedIngredientIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  avoidedGroupIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  likedIngredientIds!: string[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ username: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index(
  { googleId: 1 },
  {
    unique: true,
    partialFilterExpression: { googleId: { $type: 'string' } },
  },
);

onDelete(UserSchema, async (db, ids, session) => {
  const inIds = { $in: ids };
  await db.model('Post').deleteMany({ authorId: inIds }, { session }).exec();
  await db
    .model('VerificationRequest')
    .deleteMany({ userId: inIds }, { session })
    .exec();
  const cascadeModels: Array<[string, Record<string, unknown>]> = [
    ['Follow', { $or: [{ followerId: inIds }, { followingId: inIds }] }],
    ['Notification', { $or: [{ recipientId: inIds }, { actorId: inIds }] }],
    ['FollowSuggestion', { $or: [{ userId: inIds }, { candidateId: inIds }] }],
    ['SuggestionDismissal', { userId: inIds }],
    ['RefreshToken', { userId: inIds }],
    ['OneTimeCode', { userId: inIds }],
    ['PostComment', { authorId: inIds }],
    ['PostLike', { userId: inIds }],
    ['PostRepost', { userId: inIds }],
    ['PostBookmark', { userId: inIds }],
    ['PostReport', { reporterId: inIds }],
    ['RecipeFavorite', { userId: inIds }],
    ['RecipeRating', { userId: inIds }],
    ['MealPlanEntry', { userId: inIds }],
    ['AiUsage', { userId: inIds }],
  ];
  for (const [modelName, filter] of cascadeModels) {
    await db.model(modelName).deleteMany(filter, { session }).exec();
  }
  for (const [modelName, field] of [
    ['ProfileImageUpload', 'ownerId'],
    ['PostReport', 'reviewedById'],
    ['MediaAsset', 'ownerId'],
    ['KnowledgeDocument', 'uploadedById'],
    ['VerificationRequest', 'reviewedById'],
    ['VerificationProof', 'ownerId'],
    ['Recipe', 'createdById'],
  ] as const) {
    await db
      .model(modelName)
      .updateMany(
        { [field]: inIds },
        { $set: { [field]: null } },
        { session, timestamps: false },
      )
      .exec();
  }
});

@Schema(collectionSchema('user_account_audits', 'created'))
export class UserAccountAudit extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  actorId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({
    type: String,
    enum: Object.values(UserAccountAction),
    required: true,
  })
  action!: UserAccountAction;

  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: String, enum: Object.values(AccountStatus), required: true })
  previousStatus!: AccountStatus;

  @Prop({ type: String, enum: Object.values(AccountStatus), required: true })
  status!: AccountStatus;

  @Prop({ type: String, enum: Object.values(UserRole), required: true })
  previousRole!: UserRole;

  @Prop({ type: String, enum: Object.values(UserRole), required: true })
  role!: UserRole;

  @Prop({ type: Number, required: true })
  accountVersion!: number;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const UserAccountAuditSchema =
  SchemaFactory.createForClass(UserAccountAudit);
UserAccountAuditSchema.index({ userId: 1, createdAt: 1 });
UserAccountAuditSchema.index({ actorId: 1, createdAt: 1 });

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

@Schema(collectionSchema('notifications', 'created'))
export class Notification extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  recipientId!: string;

  @Prop({ type: String, required: true })
  actorId!: string;

  @Prop({ type: String, enum: Object.values(NotificationType), required: true })
  type!: NotificationType;

  @Prop({ type: String, default: null })
  postId!: string | null;

  @Prop({ type: String, default: null })
  commentId!: string | null;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ recipientId: 1, createdAt: 1, _id: 1 });
NotificationSchema.index({ recipientId: 1, readAt: 1 });
NotificationSchema.index({ postId: 1 });

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

/** `_id` is the email address, so codes survive deleting and re-registering. */
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
