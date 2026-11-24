import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
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
  @ApiProperty({ minimum: 0 }) replyCount!: number;
}

export class AdminCommentReportDto extends CommentReportDto {
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
  @ApiProperty({
    enum: ['DISMISS', 'REMOVE'],
    description:
      'REMOVE deletes the root and its replies, or only the selected reply',
  })
  @IsIn(['DISMISS', 'REMOVE'])
  action!: 'DISMISS' | 'REMOVE';
}
