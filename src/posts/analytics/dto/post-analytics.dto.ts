import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, Matches } from 'class-validator';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '@src/common/pagination/index.js';
import { PostType } from '@src/mongo/models.js';

export class PostAnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Inclusive Bangkok calendar date; provide together with to. Default: last 30 days.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-30',
    description: 'Inclusive Bangkok calendar date, maximum 90 days with from.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;
}

export const POST_ANALYTICS_SORTS = [
  'recent',
  'views',
  'saves',
  'likes',
  'comments',
  'reposts',
] as const;
export type PostAnalyticsSort = (typeof POST_ANALYTICS_SORTS)[number];

export class ListPostAnalyticsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    enum: POST_ANALYTICS_SORTS,
    default: 'recent',
    description:
      'recent = newest published first; other values sort by that count in the range, highest first. Ties fall back to newest first.',
  })
  @IsOptional()
  @IsIn(POST_ANALYTICS_SORTS)
  sort: PostAnalyticsSort = 'recent';
}

export class PostAnalyticsRangeDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-30' }) to!: string;
  @ApiProperty({ example: 'Asia/Bangkok' }) timeZone!: string;
  @ApiProperty({ minimum: 1, maximum: 90 }) dayCount!: number;
}

export class PostAnalyticsPreviousRangeDto {
  @ApiProperty({ example: '2026-09-01' }) from!: string;
  @ApiProperty({ example: '2026-09-30' }) to!: string;
}

export class PostAnalyticsSnapshotDto {
  @ApiProperty({ description: 'Current follower count.' })
  followers!: number;

  @ApiProperty({ description: 'Posts and blogs that are PUBLISHED now.' })
  publishedPosts!: number;

  @ApiProperty({
    description:
      'Sum of lifetime viewCount of those posts, including views from before daily tracking started.',
  })
  lifetimeViews!: number;
}

export class PostAnalyticsTotalsDto {
  @ApiProperty({
    description: 'Views on tracked days only; see viewsComplete.',
  })
  views!: number;

  @ApiProperty({
    description:
      'False when part of the period is before viewsTrackedSince, so views undercounts it.',
  })
  viewsComplete!: boolean;

  @ApiProperty({ description: 'Thích from other people, still in place.' })
  likes!: number;

  @ApiProperty({ description: 'Comments and replies by other people.' })
  comments!: number;

  @ApiProperty({ description: 'Reposts by other people, still in place.' })
  reposts!: number;

  @ApiProperty({ description: 'Bookmarks by other people, still in place.' })
  saves!: number;

  @ApiProperty({ description: 'Follows of you, still in place.' })
  newFollowers!: number;

  @ApiProperty({ description: 'Your posts published in the period.' })
  publishedPosts!: number;
}

export class PostAnalyticsDayDto {
  @ApiProperty({ example: '2026-10-01' }) date!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Null before viewsTrackedSince: unknown, not zero.',
  })
  views!: number | null;

  @ApiProperty() likes!: number;
  @ApiProperty() comments!: number;
  @ApiProperty() reposts!: number;
  @ApiProperty() saves!: number;
  @ApiProperty() newFollowers!: number;
  @ApiProperty() publishedPosts!: number;
}

export class PostAnalyticsSummaryDto {
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({ type: PostAnalyticsRangeDto }) range!: PostAnalyticsRangeDto;

  @ApiProperty({
    type: PostAnalyticsPreviousRangeDto,
    description: 'The same number of days immediately before range.',
  })
  previousRange!: PostAnalyticsPreviousRangeDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-20',
    description:
      'First day with daily view data on the platform; null if none yet.',
  })
  viewsTrackedSince!: string | null;

  @ApiProperty({ type: PostAnalyticsSnapshotDto })
  snapshot!: PostAnalyticsSnapshotDto;

  @ApiProperty({ type: PostAnalyticsTotalsDto })
  current!: PostAnalyticsTotalsDto;

  @ApiProperty({ type: PostAnalyticsTotalsDto })
  previous!: PostAnalyticsTotalsDto;

  @ApiProperty({ type: [PostAnalyticsDayDto] })
  daily!: PostAnalyticsDayDto[];

  @ApiProperty({
    type: [PostAnalyticsDayDto],
    description:
      'The previous period day by day, same length and order as daily, for an overlay line.',
  })
  previousDaily!: PostAnalyticsDayDto[];
}

export class PostAnalyticsCountsDto {
  @ApiProperty({ description: 'Views on tracked days in the range.' })
  views!: number;

  @ApiProperty() likes!: number;
  @ApiProperty() comments!: number;
  @ApiProperty() reposts!: number;
  @ApiProperty() saves!: number;
}

export class PostAnalyticsItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PostType }) type!: PostType;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Blog title, or the first 140 characters of the post body; null for a post without text.',
  })
  title!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ description: 'Lifetime viewCount of the post.' })
  lifetimeViews!: number;

  @ApiProperty({ type: PostAnalyticsCountsDto })
  period!: PostAnalyticsCountsDto;
}

export class PostAnalyticsPageDto extends PaginatedResponseDto<PostAnalyticsItemDto> {
  @ApiProperty({ type: [PostAnalyticsItemDto] })
  declare items: PostAnalyticsItemDto[];

  @ApiProperty({ type: PostAnalyticsRangeDto })
  range!: PostAnalyticsRangeDto;
}
