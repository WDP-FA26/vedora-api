export enum BillingPlan {
  PLUS = 'PLUS',
  PRO = 'PRO',
  PREMIUM = 'PREMIUM',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  CANCELLED = 'CANCELLED',
}

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum AccountStatus {
  PENDING_EMAIL = 'PENDING_EMAIL',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DELETED = 'DELETED',
  /** The built-in Vedora AI account: it cannot sign in and has no public profile. */
  SYSTEM = 'SYSTEM',
}

export enum UserAccountAction {
  SUSPEND = 'SUSPEND',
  REACTIVATE = 'REACTIVATE',
  ROLE_CHANGE = 'ROLE_CHANGE',
  DELETE = 'DELETE',
}

export enum NotificationType {
  LIKE = 'LIKE',
  COMMENT = 'COMMENT',
  COMMENT_REPLY = 'COMMENT_REPLY',
  REPOST = 'REPOST',
  FOLLOW = 'FOLLOW',
  POST_PENDING_REVIEW = 'POST_PENDING_REVIEW',
  POST_APPROVED = 'POST_APPROVED',
  POST_REJECTED = 'POST_REJECTED',
  POST_REMOVED = 'POST_REMOVED',
  POST_RESTORED = 'POST_RESTORED',
  REPORT_RESOLVED = 'REPORT_RESOLVED',
  REPORT_DISMISSED = 'REPORT_DISMISSED',
  REPORTED_POST_REMOVED = 'REPORTED_POST_REMOVED',
  SUPPORT_TICKET_REPLIED = 'SUPPORT_TICKET_REPLIED',
  SUPPORT_TICKET_RESOLVED = 'SUPPORT_TICKET_RESOLVED',
  SUPPORT_TICKET_CLOSED = 'SUPPORT_TICKET_CLOSED',
  SUPPORT_TICKET_EXPIRED = 'SUPPORT_TICKET_EXPIRED',
  SUPPORT_TICKET_REMINDER = 'SUPPORT_TICKET_REMINDER',
}

export enum FollowSuggestionReason {
  FOLLOWS_YOU = 'FOLLOWS_YOU',
  MUTUAL = 'MUTUAL',
}

export enum ProfileImageKind {
  AVATAR = 'AVATAR',
  COVER = 'COVER',
}

export enum ProfileImageStatus {
  WAITING_UPLOAD = 'WAITING_UPLOAD',
  READY = 'READY',
}

export enum OneTimeCodePurpose {
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
}

export enum PostType {
  POST = 'POST',
  BLOG = 'BLOG',
}

export enum PostStatus {
  DRAFT = 'DRAFT',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
  PENDING_REVIEW = 'PENDING_REVIEW',
  REJECTED = 'REJECTED',
  REMOVED = 'REMOVED',
}

export enum PostRemovalActor {
  ADMIN = 'ADMIN',
  AUTHOR = 'AUTHOR',
}

export enum SupportTicketCategory {
  CONTENT_APPEAL = 'CONTENT_APPEAL',
  PAYMENT_ISSUE = 'PAYMENT_ISSUE',
  VERIFICATION = 'VERIFICATION',
  GENERAL = 'GENERAL',
}

export enum SupportTicketStatus {
  OPEN = 'OPEN',
  WAITING_USER = 'WAITING_USER',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}

export enum AppealOutcome {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum AppealReasonCategory {
  FALSE_POSITIVE = 'FALSE_POSITIVE',
  CONTEXT_MISUNDERSTOOD = 'CONTEXT_MISUNDERSTOOD',
  NO_MANIPULATION = 'NO_MANIPULATION',
  OTHER = 'OTHER',
}

export enum SupportSenderRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum SupportMessageKind {
  MESSAGE = 'MESSAGE',
  DECISION_APPROVED = 'DECISION_APPROVED',
  DECISION_REJECTED = 'DECISION_REJECTED',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
  REOPENED = 'REOPENED',
  REMINDER = 'REMINDER',
}

export enum PostReportReason {
  SPAM = 'SPAM',
  HARASSMENT = 'HARASSMENT',
  MISINFORMATION = 'MISINFORMATION',
  HARMFUL_ADVICE = 'HARMFUL_ADVICE',
  INAPPROPRIATE = 'INAPPROPRIATE',
  NOT_PLANT_BASED = 'NOT_PLANT_BASED',
  OTHER = 'OTHER',
}

export enum PostReportStatus {
  PENDING = 'PENDING',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

export enum MediaType {
  VIDEO = 'VIDEO',
  IMAGE = 'IMAGE',
}

export enum MediaStatus {
  WAITING_UPLOAD = 'WAITING_UPLOAD',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export enum MediaFailureReason {
  TOO_LONG = 'TOO_LONG',
  ENCODING_FAILED = 'ENCODING_FAILED',
  UPLOAD_ERRORED = 'UPLOAD_ERRORED',
  UPLOAD_TIMED_OUT = 'UPLOAD_TIMED_OUT',
}

export enum CaptionStatus {
  NONE = 'NONE',
  TRANSCRIBING = 'TRANSCRIBING',
  READY = 'READY',
  NO_SPEECH = 'NO_SPEECH',
  FAILED = 'FAILED',
}

export enum PostSummaryStatus {
  /** Claimed by a summarizer run; released for retry once stale. */
  PENDING = 'PENDING',
  READY = 'READY',
  /** Nothing worth summarizing (too short, no speech, not about food). */
  SKIPPED = 'SKIPPED',
  /** Gave up after the maximum number of attempts. */
  FAILED = 'FAILED',
}

export enum KnowledgeDocumentStatus {
  WAITING_UPLOAD = 'WAITING_UPLOAD',
  PROCESSING = 'PROCESSING',
  AWAITING_REVIEW = 'AWAITING_REVIEW',
  INDEXING = 'INDEXING',
  READY = 'READY',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export enum KnowledgePageFlag {
  TEXT_LAYER_ADDED = 'TEXT_LAYER_ADDED',
  PAGE_COUNT_MISMATCH = 'PAGE_COUNT_MISMATCH',
}

export enum KnowledgeDocumentFailureReason {
  UPLOAD_EXPIRED = 'UPLOAD_EXPIRED',
  INVALID_FILE = 'INVALID_FILE',
  ENCRYPTED = 'ENCRYPTED',
  NO_TEXT = 'NO_TEXT',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  INDEXING_FAILED = 'INDEXING_FAILED',
}

export enum VerificationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum Weekday {
  MON = 'MON',
  TUE = 'TUE',
  WED = 'WED',
  THU = 'THU',
  FRI = 'FRI',
  SAT = 'SAT',
  SUN = 'SUN',
}

export enum MealSection {
  BREAKFAST = 'BREAKFAST',
  LUNCH = 'LUNCH',
  DINNER = 'DINNER',
  OTHER = 'OTHER',
}

/** What kind of dish a recipe is; the meal planner shows one icon per tag. */
export enum RecipeTag {
  SOUP = 'SOUP',
  SALAD = 'SALAD',
  RICE = 'RICE',
  NOODLES = 'NOODLES',
  STIR_FRY = 'STIR_FRY',
  BREAD = 'BREAD',
  DESSERT = 'DESSERT',
  DRINK = 'DRINK',
  SNACK = 'SNACK',
}

export enum AiFeature {
  MEAL_PLAN_CHAT = 'MEAL_PLAN_CHAT',
  BLOG_CHAT = 'BLOG_CHAT',
  BLOG_IMAGE = 'BLOG_IMAGE',
}
