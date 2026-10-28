// Stored enum values, kept identical to what existing documents hold. Values
// sort alphabetically nowhere in this API: services order by the arrays they
// declare.

export enum BillingPlan {
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
  REPOST = 'REPOST',
  FOLLOW = 'FOLLOW',
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
}

export enum PostReportReason {
  SPAM = 'SPAM',
  HARASSMENT = 'HARASSMENT',
  MISINFORMATION = 'MISINFORMATION',
  HARMFUL_ADVICE = 'HARMFUL_ADVICE',
  INAPPROPRIATE = 'INAPPROPRIATE',
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

export enum KnowledgeDocumentStatus {
  WAITING_UPLOAD = 'WAITING_UPLOAD',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
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

export enum AiFeature {
  BLOG_CHAT = 'BLOG_CHAT',
  BLOG_IMAGE = 'BLOG_IMAGE',
}
