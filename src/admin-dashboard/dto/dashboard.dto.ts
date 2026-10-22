import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

export class DashboardQueryDto {
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
    example: '2026-10-23',
    description: 'Inclusive Bangkok calendar date, maximum 90 days with from.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;
}

export class DashboardRangeDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ example: 'Asia/Bangkok' }) timeZone!: string;
  @ApiProperty({ minimum: 1, maximum: 90 }) dayCount!: number;
}

export class DashboardMembersDto {
  @ApiProperty() total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() suspended!: number;
  @ApiProperty() pendingEmail!: number;
}

export class DashboardSnapshotDto {
  @ApiProperty({
    type: DashboardMembersDto,
    description:
      'Current USER accounts, excluding DELETED; not filtered by date or a historical snapshot.',
  })
  members!: DashboardMembersDto;
  @ApiProperty({
    description:
      'All currently pending PostReport records, irrespective of date.',
  })
  pendingReports!: number;
}

export class PublishedContentDto {
  @ApiProperty({
    description:
      'POST records, including posts with video, published in range and still PUBLISHED.',
  })
  posts!: number;
  @ApiProperty() blogs!: number;
  @ApiProperty() total!: number;
}

export class ReportDecisionsDto {
  @ApiProperty() resolved!: number;
  @ApiProperty() dismissed!: number;
  @ApiProperty() total!: number;
}

export class DashboardPeriodDto {
  @ApiProperty({
    description: 'Remaining non-DELETED USER accounts created in range.',
  })
  newMembers!: number;
  @ApiProperty({ type: PublishedContentDto })
  publishedContent!: PublishedContentDto;
  @ApiProperty({
    description:
      'Remaining catalog recipes created in range; not an approved-content count.',
  })
  recipesCreated!: number;
  @ApiProperty() reportsCreated!: number;
  @ApiProperty({
    type: ReportDecisionsDto,
    description:
      'PostReport decisions by reviewedAt, not content approval decisions.',
  })
  reportDecisions!: ReportDecisionsDto;
}

export class DashboardDayDto {
  @ApiProperty() date!: string;
  @ApiProperty() newMembers!: number;
  @ApiProperty() publishedPosts!: number;
  @ApiProperty() publishedBlogs!: number;
  @ApiProperty() reportsCreated!: number;
  @ApiProperty() resolvedReports!: number;
  @ApiProperty() dismissedReports!: number;
}

export const UNAVAILABLE_DASHBOARD_METRICS = [
  'MODERATION_CASE_SEVERITY',
  'CONTENT_APPROVALS',
  'PAYMENT_DEMO',
] as const;

export class DashboardDto {
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({ type: DashboardRangeDto }) range!: DashboardRangeDto;
  @ApiProperty({ type: DashboardSnapshotDto }) snapshot!: DashboardSnapshotDto;
  @ApiProperty({ type: DashboardPeriodDto }) period!: DashboardPeriodDto;
  @ApiProperty({ type: [DashboardDayDto] }) daily!: DashboardDayDto[];
  @ApiProperty({
    type: [String],
    enum: UNAVAILABLE_DASHBOARD_METRICS,
    description:
      'No source exists for these metrics; display unavailable, never zero or estimated revenue/severity.',
  })
  unavailableMetrics!: (typeof UNAVAILABLE_DASHBOARD_METRICS)[number][];
}
