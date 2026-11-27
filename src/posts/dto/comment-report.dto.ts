import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';
import {
  COMMENT_REPORT_ACTIONS,
  type CommentReportAction,
} from '../../mongo/models.js';
import { PostReportDto } from './post-interaction.dto.js';

export class CommentReportDto extends PostReportDto {
  @ApiProperty({ format: 'uuid' }) commentId!: string;
}

export class ReportedCommentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) parentId!: string | null;
  @ApiProperty({ description: 'Immutable text at the time of reporting' })
  body!: string;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
  @ApiProperty({ type: String, nullable: true }) currentBody!: string | null;
  @ApiProperty() isAvailable!: boolean;
  @ApiProperty() isEdited!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque content version to confirm before removal',
  })
  currentVersion!: string | null;
  @ApiProperty({ minimum: 0 }) replyCount!: number;
}

export class AdminCommentReportDto extends CommentReportDto {
  @ApiProperty() reportCount!: number;
  @ApiProperty() pendingReportCount!: number;
  @ApiProperty() resolvedReportCount!: number;
  @ApiProperty() dismissedReportCount!: number;
  @ApiProperty({ type: Date, nullable: true }) reviewedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) reviewedById!: string | null;
  @ApiProperty({ enum: COMMENT_REPORT_ACTIONS, nullable: true })
  action!: CommentReportAction | null;
  @ApiProperty({ type: PostAuthorDto, nullable: true })
  reporter!: PostAuthorDto | null;
  @ApiProperty({ type: ReportedCommentDto }) comment!: ReportedCommentDto;
  @ApiProperty() postAvailable!: boolean;
}

export class ReviewCommentReportDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Required for REMOVE: currentVersion from the admin preview, or null for an already deleted comment',
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  expectedCommentVersion?: string | null;
  @ApiProperty({
    enum: ['DISMISS', 'REMOVE'],
    description:
      'REMOVE deletes the root and its replies, or only the selected reply',
  })
  @IsIn(['DISMISS', 'REMOVE'])
  action!: 'DISMISS' | 'REMOVE';
}
