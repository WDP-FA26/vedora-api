import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EVIDENCE_FIELDS,
  EVIDENCE_STATUSES,
  type EvidenceField,
  type EvidenceStatus,
  PostRemovalActor,
  PostStatus,
  PostType,
  REVIEW_DECISIONS,
  type ReviewDecision,
  ROUTE_APPLIERS,
  ROUTE_OUTCOMES,
  ROUTE_RULES,
  type RouteApplier,
  type RouteOutcome,
  type RouteRule,
} from '../../mongo/models.js';
import { IsIn, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/index.js';
import { AdminMediaDto } from '../../media/dto/media-response.dto.js';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';
import { BlogSummaryDto } from './blog-summary.dto.js';

export class AdminPostsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;
}

export const MODERATION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export class ModerationEvidenceItemDto {
  @ApiProperty({
    enum: EVIDENCE_FIELDS,
    description:
      'Where it is: `body`, blog `title`/`content`, a video `transcript`, a video `frame` or a blog `image`',
  })
  field!: EvidenceField;
  @ApiProperty({ description: 'Policy category key, informational only' })
  category!: string;
  @ApiProperty({ description: 'Why it breaks the policy, in Vietnamese' })
  reason!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Text fields: the exact words. Frames and images: text the model read in the picture, which may be slightly off',
  })
  quote!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Text fields: offset of `quote` in the NFC-normalized field (UTF-16 code units)',
  })
  start!: number | null;
  @ApiProperty({ nullable: true, type: Number }) end!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The video of a `transcript` or `frame` item',
  })
  mediaId!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Second of the video a `frame` was taken at',
  })
  seconds!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The frame or image the item points at',
  })
  imageUrl!: string | null;
  @ApiProperty({
    nullable: true,
    type: [Number],
    description:
      'Approximate region [x0, y0, x1, y1] of the picture, scaled 0-1000; a hint, not exact',
  })
  box!: number[] | null;
}

export class ModerationEvidenceDto {
  @ApiProperty({
    enum: EVIDENCE_STATUSES,
    description:
      'READY, FAILED (the explainer did not answer; retry with POST /admin/posts/:id/moderation/evidence) or REFUSED (its provider would not read the content)',
  })
  status!: EvidenceStatus;
  @ApiProperty({
    nullable: true,
    enum: REVIEW_DECISIONS,
    description:
      'The reviewer model: accept (System 1 was wrong), reject, or escalate to an admin. Null unless READY. Applied only when MODERATION_MODE=enforce, see `route`',
  })
  decision!: ReviewDecision | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Policy category the reviewer rejects for',
  })
  category!: string | null;
  @ApiProperty({ nullable: true, type: String }) summary!: string | null;
  @ApiProperty({ type: [ModerationEvidenceItemDto] })
  items!: ModerationEvidenceItemDto[];
  @ApiProperty({
    minimum: 0,
    description: 'Model claims dropped because they did not match the post',
  })
  dropped!: number;
  @ApiProperty() model!: string;
  @ApiProperty() createdAt!: Date;
}

export class ModerationRouteDto {
  @ApiProperty({ enum: ROUTE_OUTCOMES }) outcome!: RouteOutcome;
  @ApiProperty({
    enum: ROUTE_RULES,
    description: 'The rule of the router that matched first',
  })
  rule!: RouteRule;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The category the outcome stands for',
  })
  category!: string | null;
  @ApiProperty({
    nullable: true,
    enum: ROUTE_APPLIERS,
    description:
      'Who applied the outcome; null when it was only recorded (shadow mode, or a rerun on a post already decided)',
  })
  appliedBy!: RouteApplier | null;
  @ApiProperty() decidedAt!: Date;
}

export class AdminModerationDto {
  @ApiProperty({
    description: '`allow`, or the policy category the post most likely breaks',
  })
  verdict!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 1,
    description: "Jev's chance that the post breaks the policy",
  })
  violationScore!: number | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
    description: "Jev's chance for every category",
  })
  scores!: Record<string, number> | null;
  @ApiProperty() checkedAt!: Date;
  @ApiProperty({ nullable: true, type: String }) reviewedById!: string | null;
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) reviewNote!: string | null;
  @ApiProperty({
    nullable: true,
    type: ModerationEvidenceDto,
    description:
      'Which parts break the policy, for PENDING_REVIEW and REJECTED posts; null until the explainer ran. Admin only',
  })
  evidence!: ModerationEvidenceDto | null;
  @ApiProperty({
    nullable: true,
    type: ModerationRouteDto,
    description: 'Where the router sent the flagged post',
  })
  route!: ModerationRouteDto | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Set while the post waits for the reviewer model (enforce)',
  })
  heldAt!: Date | null;
}

export class ModeratePostDto {
  @ApiProperty({
    enum: MODERATION_DECISIONS,
    description:
      'APPROVE publishes the post; REJECT keeps or makes it REJECTED. Works on PENDING_REVIEW and REJECTED posts',
  })
  @IsIn(MODERATION_DECISIONS)
  decision!: ModerationDecision;

  @ApiPropertyOptional({ maxLength: runtimeConfig.POST_REVIEW_NOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.POST_REVIEW_NOTE_MAX_LENGTH)
  note?: string;
}

export class AdminPostRemovalDto {
  @ApiProperty({ format: 'uuid' }) removedById!: string;
  @ApiProperty({ enum: PostRemovalActor }) removedByRole!: PostRemovalActor;
  @ApiProperty() removedAt!: Date;
  @ApiProperty({ enum: PostStatus }) previousStatus!: PostStatus;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) restoredById!: string | null;
  @ApiProperty({ nullable: true, type: Date }) restoredAt!: Date | null;
}

export class RemovePostDto {
  @ApiPropertyOptional({
    maxLength: runtimeConfig.POST_REMOVAL_REASON_MAX_LENGTH,
    description:
      'Optional reason for removing the post; defaults to the top report reason when omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.POST_REMOVAL_REASON_MAX_LENGTH)
  reason?: string;
}

export class RestorePostDto {
  @ApiPropertyOptional({
    maxLength: runtimeConfig.POST_REVIEW_NOTE_MAX_LENGTH,
    description: 'Optional note shown to the author when the post is restored',
  })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.POST_REVIEW_NOTE_MAX_LENGTH)
  note?: string;
}

export class AdminPostDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PostType }) type!: PostType;
  @ApiProperty({ enum: PostStatus }) status!: PostStatus;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({ nullable: true, type: BlogSummaryDto })
  blog!: BlogSummaryDto | null;
  @ApiProperty({ nullable: true, type: Date }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
  @ApiProperty({ type: [AdminMediaDto] }) media!: AdminMediaDto[];
  @ApiProperty({ minimum: 0 }) commentCount!: number;
  @ApiProperty({ minimum: 0 }) likeCount!: number;
  @ApiProperty({ minimum: 0 }) repostCount!: number;
  @ApiProperty({ minimum: 0 }) viewCount!: number;
  @ApiProperty({
    nullable: true,
    type: AdminModerationDto,
    description: 'Result of the automated content check, null before it ran',
  })
  moderation!: AdminModerationDto | null;
  @ApiProperty({
    nullable: true,
    type: AdminPostRemovalDto,
    description:
      'Soft-delete metadata when removed (or previously removed and restored); null otherwise',
  })
  removal!: AdminPostRemovalDto | null;
}
