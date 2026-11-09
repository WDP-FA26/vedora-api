import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostStatus, PostType } from '../../mongo/models.js';
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
}

export class ModeratePostDto {
  @ApiProperty({
    enum: MODERATION_DECISIONS,
    description:
      'APPROVE publishes the post; REJECT keeps or makes it REJECTED. Works on PENDING_REVIEW and REJECTED posts',
  })
  @IsIn(MODERATION_DECISIONS)
  decision!: ModerationDecision;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
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
}
