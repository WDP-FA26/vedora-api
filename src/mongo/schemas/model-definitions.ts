import type { Connection, Schema } from 'mongoose';
import { DocumentLockSchema } from '../document-lock.js';
import type { MongoModelName } from './model-names.js';
import { AiUsageSchema } from './ai-usage.schema.js';
import { AiRequestSchema } from './ai-request.schema.js';
import { AiCostCallSchema } from './ai-cost-call.schema.js';
import {
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
import { UserAccountAuditSchema, UserSchema } from './user.schema.js';
import {
  FollowSchema,
  FollowSuggestionSchema,
  SuggestionDismissalSchema,
} from './follow.schema.js';
import { NotificationSchema } from './notification.schema.js';
import { ProfileImageUploadSchema } from './profile-image.schema.js';
import {
  EmailVerificationGuessesSchema,
  OneTimeCodeSchema,
  RefreshTokenSchema,
} from './credential.schema.js';
import {
  IngredientGroupSchema,
  IngredientSchema,
  IncompatibilityRuleSchema,
  MealPlanEntrySchema,
  RecipeFavoriteSchema,
  RecipeRatingSchema,
  RecipeSchema,
} from './recipe.schema.js';
import { KnowledgeDocumentSchema } from './knowledge.schema.js';
import { MediaAssetSchema } from './media.schema.js';
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
  { name: 'AiRequest', schema: AiRequestSchema },
  { name: 'AiCostCall', schema: AiCostCallSchema },
] as const satisfies readonly { name: MongoModelName; schema: Schema }[];

// Fails to compile when a name in MODEL_NAMES has no definition above.
type RegisteredModelName = (typeof MODEL_DEFINITIONS)[number]['name'];
export const _everyModelNameIsRegistered: [MongoModelName] extends [
  RegisteredModelName,
]
  ? true
  : never = true;

export function registerModels(connection: Connection): void {
  for (const { name, schema } of MODEL_DEFINITIONS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
}
