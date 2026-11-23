import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AccountStatus,
  AccountType,
  ActivityLevel,
  BiologicalSex,
  BodyFeeling,
  NutritionGoal,
  UserAccountAction,
  UserRole,
} from '../enums.js';
import { cascadeOnDelete, collectionSchema } from './common.js';
import { Identified } from './identified.js';

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

  @Prop({
    type: String,
    enum: Object.values(AccountType),
    required: true,
    default: AccountType.PERSONAL,
  })
  accountType!: AccountType;

  @Prop({ type: Number, required: true, default: 0 })
  accountVersion!: number;

  @Prop({ type: Boolean, required: true, default: false })
  isProfessional!: boolean;

  @Prop({ type: Date, default: null })
  emailVerifiedAt!: Date | null;

  @Prop({ type: Date, default: null })
  searchIndexedAt!: Date | null;

  @Prop({ type: [String], required: true, default: [] })
  avoidedIngredientIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  avoidedGroupIds!: string[];

  @Prop({ type: String, default: null })
  allergyNote!: string | null;

  @Prop({ type: String, default: null })
  preferenceNote!: string | null;

  @Prop({ type: Number, default: null })
  heightCm!: number | null;

  @Prop({ type: Number, default: null })
  weightKg!: number | null;

  @Prop({ type: Number, default: null })
  targetWeightKg!: number | null;

  @Prop({ type: Number, default: null })
  birthYear!: number | null;

  @Prop({
    type: String,
    enum: Object.values(BiologicalSex),
    default: null,
  })
  biologicalSex!: BiologicalSex | null;

  @Prop({
    type: String,
    enum: Object.values(ActivityLevel),
    default: null,
  })
  activityLevel!: ActivityLevel | null;

  @Prop({
    type: String,
    enum: Object.values(NutritionGoal),
    default: null,
  })
  nutritionGoal!: NutritionGoal | null;

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
UserSchema.index({ status: 1, emailVerifiedAt: 1, searchIndexedAt: 1 });

cascadeOnDelete(UserSchema, [
  { model: 'Post', field: 'authorId', action: 'delete' },
  { model: 'VerificationRequest', field: 'userId', action: 'delete' },
  { model: 'WorkspaceMember', field: 'userId', action: 'delete' },
  { model: 'Workspace', field: 'pageUserId', action: 'delete' },
  { model: 'RestaurantReview', field: 'authorId', action: 'delete' },
  { model: 'Conversation', field: 'lowId', action: 'delete' },
  { model: 'Conversation', field: 'highId', action: 'delete' },
  { model: 'MessagingEvent', field: 'userIds', action: 'delete' },
  { model: 'Follow', field: 'followerId', action: 'delete' },
  { model: 'Follow', field: 'followingId', action: 'delete' },
  { model: 'Notification', field: 'recipientId', action: 'delete' },
  { model: 'Notification', field: 'actorId', action: 'delete' },
  { model: 'FollowSuggestion', field: 'userId', action: 'delete' },
  { model: 'FollowSuggestion', field: 'candidateId', action: 'delete' },
  { model: 'SuggestionDismissal', field: 'userId', action: 'delete' },
  { model: 'RefreshToken', field: 'userId', action: 'delete' },
  { model: 'RefreshToken', field: 'actorId', action: 'delete' },
  { model: 'OneTimeCode', field: 'userId', action: 'delete' },
  { model: 'PostComment', field: 'authorId', action: 'delete' },
  { model: 'PostLike', field: 'userId', action: 'delete' },
  { model: 'PostRepost', field: 'userId', action: 'delete' },
  { model: 'PostBookmark', field: 'userId', action: 'delete' },
  { model: 'PostReport', field: 'reporterId', action: 'delete' },
  { model: 'RecipeFavorite', field: 'userId', action: 'delete' },
  { model: 'RecipeRating', field: 'userId', action: 'delete' },
  { model: 'MealPlanEntry', field: 'userId', action: 'delete' },
  { model: 'MealLogEntry', field: 'userId', action: 'delete' },
  { model: 'MealPlanChatThread', field: 'userId', action: 'delete' },
  { model: 'MealPlanChatMessage', field: 'userId', action: 'delete' },
  { model: 'AiUsage', field: 'userId', action: 'delete' },
  { model: 'BodyMetricLog', field: 'userId', action: 'delete' },
  { model: 'ProfileImageUpload', field: 'ownerId', action: 'unset' },
  { model: 'PostReport', field: 'reviewedById', action: 'unset' },
  { model: 'MediaAsset', field: 'ownerId', action: 'unset' },
  { model: 'KnowledgeDocument', field: 'uploadedById', action: 'unset' },
  { model: 'VerificationRequest', field: 'reviewedById', action: 'unset' },
  { model: 'VerificationProof', field: 'ownerId', action: 'unset' },
  { model: 'WorkspaceProof', field: 'ownerId', action: 'unset' },
  { model: 'Workspace', field: 'reviewedById', action: 'unset' },
  { model: 'Recipe', field: 'createdById', action: 'unset' },
]);

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

/** One weight/BMI check-in entry per user per calendar day (`YYYY-MM-DD`). */
@Schema(collectionSchema('body_metric_logs'))
export class BodyMetricLog extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  date!: string;

  @Prop({ type: Number, required: true })
  weightKg!: number;

  @Prop({ type: Number, required: true })
  heightCm!: number;

  @Prop({ type: Number, required: true })
  bmi!: number;

  @Prop({
    type: String,
    enum: Object.values(BodyFeeling),
    default: null,
  })
  feeling!: BodyFeeling | null;

  @Prop({ type: String, default: null })
  note!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const BodyMetricLogSchema = SchemaFactory.createForClass(BodyMetricLog);
BodyMetricLogSchema.index({ userId: 1, date: 1 }, { unique: true });
BodyMetricLogSchema.index({ userId: 1, date: -1 });
