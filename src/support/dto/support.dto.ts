import { runtimeConfig } from '../../config/runtime-config.js';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../common/pagination/index.js';
import {
  APPEAL_TRIGGER_STATUSES,
  AppealOutcome,
  AppealReasonCategory,
  type AppealTriggerStatus,
  PostType,
  SupportMessageKind,
  SupportSenderRole,
  SupportTicketCategory,
  SupportTicketStatus,
} from '../../mongo/models.js';
import { AdminPostDto } from '../../posts/dto/admin-post.dto.js';
import { PostResponseDto } from '../../posts/dto/post-response.dto.js';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const SUPPORT_RESOLVE_DECISIONS = [
  'APPROVE',
  'REJECT',
  'RESOLVE',
  'CLOSE',
] as const;
export type SupportResolveDecision = (typeof SUPPORT_RESOLVE_DECISIONS)[number];

export const SUPPORT_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type SupportAttachmentType = (typeof SUPPORT_ATTACHMENT_TYPES)[number];

export const ADMIN_ASSIGNEE_FILTERS = ['me', 'unassigned'] as const;
export type AdminAssigneeFilter = (typeof ADMIN_ASSIGNEE_FILTERS)[number];

const MAX_ATTACHMENTS = runtimeConfig.SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE;

function AttachmentIds() {
  return applyDecorators(
    ApiPropertyOptional({
      type: [String],
      format: 'uuid',
      maxItems: MAX_ATTACHMENTS,
      description: 'Uploaded image ids from POST /support/attachments',
    }),
    IsOptional(),
    IsArray(),
    ArrayMaxSize(MAX_ATTACHMENTS),
    ArrayUnique(),
    IsUUID('4', { each: true }),
  );
}

export class CreateSupportAttachmentUploadDto {
  @ApiProperty({ enum: SUPPORT_ATTACHMENT_TYPES })
  @IsIn(SUPPORT_ATTACHMENT_TYPES)
  contentType!: SupportAttachmentType;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class SupportAttachmentUploadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: PresignedUploadDto,
    description: 'PUT the image here, then send its id in attachmentIds',
  })
  upload!: PresignedUploadDto;
}

export class SupportAttachmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Short-lived signed download URL' })
  url!: string;
  @ApiProperty({ enum: SUPPORT_ATTACHMENT_TYPES }) contentType!: string;
  @ApiProperty({ minimum: 1 }) sizeBytes!: number;
}

export class CreateSupportTicketDto {
  @ApiProperty({ enum: SupportTicketCategory })
  @IsEnum(SupportTicketCategory)
  category!: SupportTicketCategory;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
    description:
      'Required for non-appeal categories; optional for CONTENT_APPEAL (defaults to post title/excerpt)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.SUPPORT_TICKET_SUBJECT_MAX_LENGTH)
  subject?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: runtimeConfig.APPEAL_MESSAGE_MAX_LENGTH,
    description: 'Initial plain-text message',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.APPEAL_MESSAGE_MAX_LENGTH)
  message!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required when category is CONTENT_APPEAL',
  })
  @IsOptional()
  @IsUUID('4')
  postId?: string;

  @ApiPropertyOptional({
    enum: AppealReasonCategory,
    default: AppealReasonCategory.OTHER,
    description: 'Used when category is CONTENT_APPEAL',
  })
  @IsOptional()
  @IsEnum(AppealReasonCategory)
  reasonCategory?: AppealReasonCategory;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.SUPPORT_TICKET_REFERENCE_MAX_LENGTH,
    description:
      'Optional external reference (e.g. SePay transfer code) for payment or verification tickets',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.SUPPORT_TICKET_REFERENCE_MAX_LENGTH)
  referenceCode?: string;

  @AttachmentIds()
  attachmentIds?: string[];
}

export class ListMyTicketsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: SupportTicketCategory })
  @IsOptional()
  @IsEnum(SupportTicketCategory)
  category?: SupportTicketCategory;
}

export class CreateSupportMessageDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: runtimeConfig.APPEAL_MESSAGE_MAX_LENGTH,
    description: 'Plain text; may be omitted when attachmentIds is non-empty',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.APPEAL_MESSAGE_MAX_LENGTH)
  body?: string;

  @AttachmentIds()
  attachmentIds?: string[];
}

export class AdminListTicketsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: SupportTicketCategory })
  @IsOptional()
  @IsEnum(SupportTicketCategory)
  category?: SupportTicketCategory;

  @ApiPropertyOptional({ enum: APPEAL_TRIGGER_STATUSES })
  @IsOptional()
  @IsIn(APPEAL_TRIGGER_STATUSES)
  triggerStatus?: AppealTriggerStatus;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Search by ticket code, subject, referenceCode, or post excerpt',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: ADMIN_ASSIGNEE_FILTERS,
    description: 'me = claimed by the caller; unassigned = nobody claimed it',
  })
  @IsOptional()
  @IsIn(ADMIN_ASSIGNEE_FILTERS)
  assignee?: AdminAssigneeFilter;
}

export class ClaimSupportTicketDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Take over a ticket another admin has claimed',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class AdminCreateSupportMessageDto extends CreateSupportMessageDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'When true, stores an internal admin-only note without notifying the user or changing ticket status',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class ResolveSupportTicketDto {
  @ApiProperty({
    enum: SUPPORT_RESOLVE_DECISIONS,
    description:
      'CONTENT_APPEAL tickets take APPROVE or REJECT; all other categories take RESOLVE or CLOSE',
  })
  @IsIn(SUPPORT_RESOLVE_DECISIONS)
  decision!: SupportResolveDecision;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.APPEAL_RESOLUTION_NOTE_MAX_LENGTH,
    description:
      'Required (at least 5 characters) when decision is REJECT or CLOSE',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.APPEAL_RESOLUTION_NOTE_MAX_LENGTH)
  note?: string;
}

export class AppealPostSnapshotDto {
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) excerpt!: string | null;
  @ApiProperty({ nullable: true, type: String }) verdict!: string | null;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty() blockedAt!: Date;
}

export class SupportAppealDataDto {
  @ApiProperty({ format: 'uuid' }) postId!: string;
  @ApiProperty({ enum: PostType }) postType!: PostType;
  @ApiProperty({ enum: APPEAL_TRIGGER_STATUSES })
  triggerStatus!: AppealTriggerStatus;
  @ApiProperty({ enum: AppealReasonCategory })
  reasonCategory!: AppealReasonCategory;
  @ApiProperty({ nullable: true, enum: AppealOutcome })
  outcome!: AppealOutcome | null;
  @ApiProperty({ type: AppealPostSnapshotDto })
  postSnapshot!: AppealPostSnapshotDto;
}

export class SupportMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) ticketId!: string;
  @ApiProperty({ nullable: true, type: PostAuthorDto })
  sender!: PostAuthorDto | null;
  @ApiProperty({ enum: SupportSenderRole }) senderRole!: SupportSenderRole;
  @ApiProperty({ enum: SupportMessageKind }) kind!: SupportMessageKind;
  @ApiProperty() isInternal!: boolean;
  @ApiProperty({ description: 'Empty when the message has only attachments' })
  body!: string;
  @ApiProperty({ type: [SupportAttachmentDto] })
  attachments!: SupportAttachmentDto[];
  @ApiProperty() createdAt!: Date;
}

export class SupportTicketListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'APL-8F2K9C' }) code!: string;
  @ApiProperty({ enum: SupportTicketCategory })
  category!: SupportTicketCategory;
  @ApiProperty() subject!: string;
  @ApiProperty({ enum: SupportTicketStatus }) status!: SupportTicketStatus;
  @ApiProperty({ nullable: true, type: SupportAppealDataDto })
  appeal!: SupportAppealDataDto | null;
  @ApiProperty({ nullable: true, type: String })
  referenceCode!: string | null;
  @ApiProperty() lastMessageAt!: Date;
  @ApiProperty({ enum: SupportSenderRole })
  lastMessageByRole!: SupportSenderRole;
  @ApiProperty({ minimum: 0 }) messageCount!: number;
  @ApiProperty({ nullable: true, type: Date })
  waitingUserSince!: Date | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'When a WAITING_USER ticket closes as EXPIRED if the author stays silent',
  })
  autoCloseAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) resolvedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String })
  resolutionNote!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class SupportTicketDetailDto extends SupportTicketListItemDto {
  @ApiProperty({ type: [SupportMessageDto] }) messages!: SupportMessageDto[];
  @ApiProperty({ nullable: true, type: PostResponseDto })
  post!: PostResponseDto | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'For a finished non-appeal ticket: replying before this time reopens it',
  })
  reopenableUntil!: Date | null;
}

export class AdminSupportTicketListItemDto extends SupportTicketListItemDto {
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
  @ApiProperty({ nullable: true, type: PostAuthorDto })
  resolvedBy!: PostAuthorDto | null;
  @ApiProperty({ nullable: true, type: PostAuthorDto })
  assignee!: PostAuthorDto | null;
  @ApiProperty({ nullable: true, type: Date }) assignedAt!: Date | null;
}

export class AdminSupportStatusCountsDto {
  @ApiProperty({ minimum: 0 }) open!: number;
  @ApiProperty({ minimum: 0 }) waitingUser!: number;
  @ApiProperty({ minimum: 0 }) resolved!: number;
  @ApiProperty({ minimum: 0 }) closed!: number;
  @ApiProperty({ minimum: 0 }) withdrawn!: number;
  @ApiProperty({ minimum: 0 }) expired!: number;
  @ApiProperty({ minimum: 0 }) total!: number;
}

export class AdminSupportCategoryCountsDto {
  @ApiProperty({ minimum: 0 }) contentAppeal!: number;
  @ApiProperty({ minimum: 0 }) paymentIssue!: number;
  @ApiProperty({ minimum: 0 }) verification!: number;
  @ApiProperty({ minimum: 0 }) general!: number;
}

export class AdminSupportTicketsPageDto extends PaginatedResponseDto<AdminSupportTicketListItemDto> {
  @ApiProperty({ type: [AdminSupportTicketListItemDto] })
  declare items: AdminSupportTicketListItemDto[];

  @ApiProperty({ type: AdminSupportStatusCountsDto })
  counts!: AdminSupportStatusCountsDto;

  @ApiProperty({ type: AdminSupportCategoryCountsDto })
  categoryCounts!: AdminSupportCategoryCountsDto;
}

export class AdminSupportTicketDetailDto extends AdminSupportTicketListItemDto {
  @ApiProperty({ type: [SupportMessageDto] }) messages!: SupportMessageDto[];
  @ApiProperty({ nullable: true, type: AdminPostDto })
  post!: AdminPostDto | null;
}
