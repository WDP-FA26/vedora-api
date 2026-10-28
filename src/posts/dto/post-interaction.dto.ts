import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostReportReason, PostReportStatus } from '../../mongo/models.js';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/index.js';
import { PostAuthorDto } from './post-response.dto.js';

export const MAX_VIEW_BATCH = 50;
export const MAX_REPORT_DETAILS_LENGTH = 500;

const REPORT_DECISIONS = [
  PostReportStatus.RESOLVED,
  PostReportStatus.DISMISSED,
] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

export class PostRepostResponseDto {
  @ApiProperty({ format: 'uuid' }) postId!: string;
  @ApiProperty() isReposted!: boolean;
  @ApiProperty({ minimum: 0 }) repostCount!: number;
}

export class PostBookmarkResponseDto {
  @ApiProperty({ format: 'uuid' }) postId!: string;
  @ApiProperty() isBookmarked!: boolean;
}

export class RecordViewsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_VIEW_BATCH,
    description: 'Posts that were on screen since the last batch',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VIEW_BATCH)
  @IsUUID('4', { each: true })
  postIds!: string[];
}

export class CreatePostReportDto {
  @ApiProperty({ enum: PostReportReason })
  @IsEnum(PostReportReason)
  reason!: PostReportReason;

  @ApiPropertyOptional({ maxLength: MAX_REPORT_DETAILS_LENGTH })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REPORT_DETAILS_LENGTH)
  details?: string;
}

export class PostReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) postId!: string;
  @ApiProperty({ enum: PostReportReason }) reason!: PostReportReason;
  @ApiProperty({ nullable: true, type: String }) details!: string | null;
  @ApiProperty({ enum: PostReportStatus }) status!: PostReportStatus;
  @ApiProperty() createdAt!: Date;
}

export class ReportedPostDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
}

export class AdminPostReportDto extends PostReportDto {
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty({ type: PostAuthorDto }) reporter!: PostAuthorDto;
  @ApiProperty({ type: ReportedPostDto }) post!: ReportedPostDto;
}

export class PostReportsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PostReportStatus })
  @IsOptional()
  @IsEnum(PostReportStatus)
  status?: PostReportStatus;
}

export class ReviewPostReportDto {
  @ApiProperty({
    enum: REPORT_DECISIONS,
    description:
      'RESOLVED once the post was dealt with, DISMISSED if it is fine',
  })
  @IsIn(REPORT_DECISIONS)
  status!: ReportDecision;
}
