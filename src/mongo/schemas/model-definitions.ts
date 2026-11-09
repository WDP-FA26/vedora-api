import type { Connection, Schema } from 'mongoose';
import { DocumentLockSchema } from '../document-lock.js';
import {
  AiUsageSchema,
  PaymentIntentSchema,
  PaymentRequestSchema,
  PaymentWebhookReceiptSchema,
} from './payment.schema.js';
import {
  PostBookmarkSchema,
  PostCommentSchema,
  PostLikeSchema,
  PostReportSchema,
  PostRepostSchema,
  PostSchema,
} from './post.schema.js';
import {
  EmailVerificationGuessesSchema,
  FollowSchema,
  FollowSuggestionSchema,
  NotificationSchema,
  OneTimeCodeSchema,
  ProfileImageUploadSchema,
  RefreshTokenSchema,
  SuggestionDismissalSchema,
  UserAccountAuditSchema,
  UserSchema,
} from './user.schema.js';
import {
  IngredientGroupSchema,
  IngredientSchema,
  IncompatibilityRuleSchema,
  MealPlanEntrySchema,
  RecipeFavoriteSchema,
  RecipeRatingSchema,
  RecipeSchema,
} from './recipe.schema.js';
import { KnowledgeDocumentSchema, MediaAssetSchema } from './media.schema.js';
import { ModerationSettingsSchema } from './moderation.schema.js';
import {
  VerificationProofSchema,
  VerificationRequestSchema,
} from './verification.schema.js';
import {
  ConversationSchema,
  DirectMessageSchema,
  MessagingEventSchema,
} from './messaging.schema.js';

export const MODEL_DEFINITIONS = [
  { name: 'DocumentLock', schema: DocumentLockSchema },
  { name: 'Conversation', schema: ConversationSchema },
  { name: 'DirectMessage', schema: DirectMessageSchema },
  { name: 'MessagingEvent', schema: MessagingEventSchema },
  { name: 'User', schema: UserSchema },
  { name: 'UserAccountAudit', schema: UserAccountAuditSchema },
  { name: 'Follow', schema: FollowSchema },
  { name: 'Notification', schema: NotificationSchema },
  { name: 'ModerationSettings', schema: ModerationSettingsSchema },
  { name: 'FollowSuggestion', schema: FollowSuggestionSchema },
  { name: 'SuggestionDismissal', schema: SuggestionDismissalSchema },
  { name: 'ProfileImageUpload', schema: ProfileImageUploadSchema },
  { name: 'RefreshToken', schema: RefreshTokenSchema },
  { name: 'OneTimeCode', schema: OneTimeCodeSchema },
  { name: 'EmailVerificationGuesses', schema: EmailVerificationGuessesSchema },
  { name: 'Post', schema: PostSchema },
  { name: 'PostComment', schema: PostCommentSchema },
  { name: 'PostLike', schema: PostLikeSchema },
  { name: 'PostRepost', schema: PostRepostSchema },
  { name: 'PostBookmark', schema: PostBookmarkSchema },
  { name: 'PostReport', schema: PostReportSchema },
  { name: 'MediaAsset', schema: MediaAssetSchema },
  { name: 'KnowledgeDocument', schema: KnowledgeDocumentSchema },
  { name: 'VerificationRequest', schema: VerificationRequestSchema },
  { name: 'VerificationProof', schema: VerificationProofSchema },
  { name: 'Ingredient', schema: IngredientSchema },
  { name: 'IngredientGroup', schema: IngredientGroupSchema },
  { name: 'IncompatibilityRule', schema: IncompatibilityRuleSchema },
  { name: 'Recipe', schema: RecipeSchema },
  { name: 'RecipeFavorite', schema: RecipeFavoriteSchema },
  { name: 'RecipeRating', schema: RecipeRatingSchema },
  { name: 'MealPlanEntry', schema: MealPlanEntrySchema },
  { name: 'PaymentIntent', schema: PaymentIntentSchema },
  { name: 'PaymentRequest', schema: PaymentRequestSchema },
  { name: 'PaymentWebhookReceipt', schema: PaymentWebhookReceiptSchema },
  { name: 'AiUsage', schema: AiUsageSchema },
] as const satisfies readonly { name: string; schema: Schema }[];

export type MongoModelName = (typeof MODEL_DEFINITIONS)[number]['name'];

export function registerModels(connection: Connection): void {
  for (const { name, schema } of MODEL_DEFINITIONS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
}
