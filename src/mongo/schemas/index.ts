import type { Connection, Schema } from 'mongoose';
import {
  BlogRecipeSchema,
  BlogSchema,
  PostBookmarkSchema,
  PostCommentSchema,
  PostLikeSchema,
  PostReportSchema,
  PostRepostSchema,
  PostSchema,
} from './post.schema';
import {
  AiUsageSchema,
  PaymentIntentSchema,
  PaymentRequestSchema,
  PaymentWebhookReceiptSchema,
} from './payment.schema';
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
} from './user.schema';
import {
  IngredientGroupMemberSchema,
  IngredientGroupSchema,
  IngredientSchema,
  IncompatibilityRuleSchema,
  MealPlanEntrySchema,
  RecipeFavoriteSchema,
  RecipeIngredientSchema,
  RecipeRatingSchema,
  RecipeSchema,
} from './recipe.schema';
import { KnowledgeDocumentSchema, MediaAssetSchema } from './media.schema';
import {
  VerificationProofSchema,
  VerificationRequestSchema,
} from './verification.schema';

export * from './user.schema';
export * from './post.schema';
export * from './media.schema';
export * from './verification.schema';
export * from './recipe.schema';
export * from './payment.schema';

/** Every collection the API reads or writes, keyed by its model name. */
export const MODEL_DEFINITIONS: { name: string; schema: Schema }[] = [
  { name: 'User', schema: UserSchema },
  { name: 'UserAccountAudit', schema: UserAccountAuditSchema },
  { name: 'Follow', schema: FollowSchema },
  { name: 'Notification', schema: NotificationSchema },
  { name: 'FollowSuggestion', schema: FollowSuggestionSchema },
  { name: 'SuggestionDismissal', schema: SuggestionDismissalSchema },
  { name: 'ProfileImageUpload', schema: ProfileImageUploadSchema },
  { name: 'RefreshToken', schema: RefreshTokenSchema },
  { name: 'OneTimeCode', schema: OneTimeCodeSchema },
  { name: 'EmailVerificationGuesses', schema: EmailVerificationGuessesSchema },
  { name: 'Post', schema: PostSchema },
  { name: 'Blog', schema: BlogSchema },
  { name: 'BlogRecipe', schema: BlogRecipeSchema },
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
  { name: 'IngredientGroupMember', schema: IngredientGroupMemberSchema },
  { name: 'IncompatibilityRule', schema: IncompatibilityRuleSchema },
  { name: 'Recipe', schema: RecipeSchema },
  { name: 'RecipeIngredient', schema: RecipeIngredientSchema },
  { name: 'RecipeFavorite', schema: RecipeFavoriteSchema },
  { name: 'RecipeRating', schema: RecipeRatingSchema },
  { name: 'MealPlanEntry', schema: MealPlanEntrySchema },
  { name: 'PaymentIntent', schema: PaymentIntentSchema },
  { name: 'PaymentRequest', schema: PaymentRequestSchema },
  { name: 'PaymentWebhookReceipt', schema: PaymentWebhookReceiptSchema },
  { name: 'AiUsage', schema: AiUsageSchema },
];

/** Registers every schema on a connection outside Nest (seeds, scripts). */
export function registerModels(connection: Connection): void {
  for (const { name, schema } of MODEL_DEFINITIONS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
}
