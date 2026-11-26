import type { Connection, Schema } from 'mongoose';
import { DocumentLockSchema } from '../document-lock.js';
import { SystemLogSchema } from './system-log.schema.js';
import { PostReportEvidenceSchema } from './post-report-evidence.schema.js';
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
  SupportAttachmentSchema,
  SupportMessageSchema,
  SupportTicketSchema,
} from './support.schema.js';
import {
  PostBookmarkSchema,
  PostCommentSchema,
  PostLikeSchema,
  PostReportSchema,
  PostRepostSchema,
  PostSchema,
  PostViewDaySchema,
} from './post.schema.js';
import {
  BodyMetricLogSchema,
  UserAccountAuditSchema,
  UserSchema,
} from './user.schema.js';
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
  RecipeCategorySchema,
  IncompatibilityRuleSchema,
  MealPlanEntrySchema,
  RecipeFavoriteSchema,
  RecipeRatingSchema,
  RecipeSchema,
} from './recipe.schema.js';
import { MealLogEntrySchema } from './meal-log.schema.js';
import {
  KnowledgeDocumentSchema,
  KnowledgePageSchema,
} from './knowledge.schema.js';
import { MediaAssetSchema } from './media.schema.js';
import { PostSummarySchema } from './post-summary.schema.js';
import { CommentReportSchema } from './comment-report.schema.js';
import { ModerationSettingsSchema } from './moderation.schema.js';
import {
  VerificationProofSchema,
  VerificationRequestSchema,
} from './verification.schema.js';
import {
  RestaurantMenuItemSchema,
  RestaurantReviewSchema,
  WorkspaceMemberSchema,
  WorkspaceProofSchema,
  WorkspaceSchema,
} from './workspace.schema.js';
import {
  MealPlanChatMessageSchema,
  MealPlanChatThreadSchema,
} from './meal-plan-chat.schema.js';
import {
  MessagingEventSchema,
  ConversationSchema,
  DirectMessageSchema,
} from './messaging.schema.js';

export const MODEL_DEFINITIONS = [
  { name: 'PostReportEvidence', schema: PostReportEvidenceSchema },
  { name: 'DocumentLock', schema: DocumentLockSchema },
  { name: 'Conversation', schema: ConversationSchema },
  { name: 'DirectMessage', schema: DirectMessageSchema },
  { name: 'MessagingEvent', schema: MessagingEventSchema },
  { name: 'User', schema: UserSchema },
  { name: 'UserAccountAudit', schema: UserAccountAuditSchema },
  { name: 'SystemLog', schema: SystemLogSchema },
  { name: 'BodyMetricLog', schema: BodyMetricLogSchema },
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
  { name: 'CommentReport', schema: CommentReportSchema },
  { name: 'PostViewDay', schema: PostViewDaySchema },
  { name: 'PostSummary', schema: PostSummarySchema },
  { name: 'SupportTicket', schema: SupportTicketSchema },
  { name: 'SupportMessage', schema: SupportMessageSchema },
  { name: 'SupportAttachment', schema: SupportAttachmentSchema },
  { name: 'MediaAsset', schema: MediaAssetSchema },
  { name: 'KnowledgeDocument', schema: KnowledgeDocumentSchema },
  { name: 'KnowledgePage', schema: KnowledgePageSchema },
  { name: 'VerificationRequest', schema: VerificationRequestSchema },
  { name: 'VerificationProof', schema: VerificationProofSchema },
  { name: 'Workspace', schema: WorkspaceSchema },
  { name: 'WorkspaceMember', schema: WorkspaceMemberSchema },
  { name: 'WorkspaceProof', schema: WorkspaceProofSchema },
  { name: 'RestaurantMenuItem', schema: RestaurantMenuItemSchema },
  { name: 'RestaurantReview', schema: RestaurantReviewSchema },
  { name: 'Ingredient', schema: IngredientSchema },
  { name: 'IngredientGroup', schema: IngredientGroupSchema },
  { name: 'RecipeCategory', schema: RecipeCategorySchema },
  { name: 'IncompatibilityRule', schema: IncompatibilityRuleSchema },
  { name: 'Recipe', schema: RecipeSchema },
  { name: 'RecipeFavorite', schema: RecipeFavoriteSchema },
  { name: 'RecipeRating', schema: RecipeRatingSchema },
  { name: 'MealPlanEntry', schema: MealPlanEntrySchema },
  { name: 'MealLogEntry', schema: MealLogEntrySchema },
  { name: 'MealPlanChatThread', schema: MealPlanChatThreadSchema },
  { name: 'MealPlanChatMessage', schema: MealPlanChatMessageSchema },
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
