import { Injectable } from '@nestjs/common';
import { AccountStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DAY_MS, resolveDashboardRange } from './dashboard-range';
import {
  DashboardDayDto,
  DashboardDto,
  DashboardQueryDto,
  UNAVAILABLE_DASHBOARD_METRICS,
} from './dto/dashboard.dto';

type DayCounts = Omit<DashboardDayDto, 'date'>;
type DatabaseDay = { date: string } & Record<keyof DayCounts, bigint>;
const emptyCounts = (): DayCounts => ({
  newMembers: 0,
  publishedPosts: 0,
  publishedBlogs: 0,
  reportsCreated: 0,
  resolvedReports: 0,
  dismissedReports: 0,
});

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(query: DashboardQueryDto): Promise<DashboardDto> {
    const range = resolveDashboardRange(query);
    const { start, endExclusive, ...publicRange } = range;
    return this.prisma.$transaction(
      async (tx) => {
        const members = await tx.user.groupBy({
          by: ['status'],
          where: {
            role: UserRole.USER,
            status: { not: AccountStatus.DELETED },
          },
          _count: { _all: true },
        });
        const pendingReports = await tx.postReport.count({
          where: { status: 'PENDING' },
        });
        const recipesCreated = await tx.recipe.count({
          where: { createdAt: { gte: start, lt: endExclusive } },
        });
        // Only aggregate values cross the DB boundary. Four event scans are
        // combined into one daily grouping; there is no per-day query or PII.
        // Prisma DateTime columns are UTC timestamp WITHOUT time zone.
        const rows = await tx.$queryRaw<DatabaseDay[]>(Prisma.sql`
        SELECT to_char(occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS date,
          COUNT(*) FILTER (WHERE event = 'MEMBER') AS "newMembers",
          COUNT(*) FILTER (WHERE event = 'POST') AS "publishedPosts",
          COUNT(*) FILTER (WHERE event = 'BLOG') AS "publishedBlogs",
          COUNT(*) FILTER (WHERE event = 'REPORT') AS "reportsCreated",
          COUNT(*) FILTER (WHERE event = 'RESOLVED') AS "resolvedReports",
          COUNT(*) FILTER (WHERE event = 'DISMISSED') AS "dismissedReports"
        FROM (
          SELECT "createdAt" AS occurred_at, 'MEMBER'::text AS event FROM users
          WHERE role = 'USER' AND status <> 'DELETED'
            AND "createdAt" >= (${start}::timestamptz AT TIME ZONE 'UTC')
            AND "createdAt" < (${endExclusive}::timestamptz AT TIME ZONE 'UTC')
          UNION ALL
          SELECT published_at, type::text FROM posts
          WHERE status = 'PUBLISHED'
            AND published_at >= (${start}::timestamptz AT TIME ZONE 'UTC')
            AND published_at < (${endExclusive}::timestamptz AT TIME ZONE 'UTC')
          UNION ALL
          SELECT created_at, 'REPORT'::text FROM post_reports
          WHERE created_at >= (${start}::timestamptz AT TIME ZONE 'UTC')
            AND created_at < (${endExclusive}::timestamptz AT TIME ZONE 'UTC')
          UNION ALL
          SELECT reviewed_at, status::text FROM post_reports
          WHERE status IN ('RESOLVED', 'DISMISSED')
            AND reviewed_at >= (${start}::timestamptz AT TIME ZONE 'UTC')
            AND reviewed_at < (${endExclusive}::timestamptz AT TIME ZONE 'UTC')
        ) activity
        GROUP BY date ORDER BY date
      `);
        const byDate = new Map(rows.map((row) => [row.date, row]));
        const totals = emptyCounts();
        const daily = Array.from(
          { length: range.dayCount },
          (_, index): DashboardDayDto => {
            const date = new Date(
              Date.parse(`${range.from}T00:00:00Z`) + index * DAY_MS,
            )
              .toISOString()
              .slice(0, 10);
            const row = byDate.get(date);
            const counts = emptyCounts();
            for (const key of Object.keys(counts) as (keyof DayCounts)[]) {
              const value = Number(row?.[key] ?? 0);
              if (!Number.isSafeInteger(value))
                throw new Error(
                  'Dashboard aggregate exceeds safe integer range',
                );
              counts[key] = value;
              totals[key] += value;
            }
            return { date, ...counts };
          },
        );
        const count = (status: AccountStatus) =>
          members.find((group) => group.status === status)?._count._all ?? 0;
        const active = count(AccountStatus.ACTIVE),
          suspended = count(AccountStatus.SUSPENDED),
          pendingEmail = count(AccountStatus.PENDING_EMAIL);
        return {
          generatedAt: new Date().toISOString(),
          range: publicRange,
          snapshot: {
            members: {
              total: active + suspended + pendingEmail,
              active,
              suspended,
              pendingEmail,
            },
            pendingReports,
          },
          period: {
            newMembers: totals.newMembers,
            publishedContent: {
              posts: totals.publishedPosts,
              blogs: totals.publishedBlogs,
              total: totals.publishedPosts + totals.publishedBlogs,
            },
            recipesCreated,
            reportsCreated: totals.reportsCreated,
            reportDecisions: {
              resolved: totals.resolvedReports,
              dismissed: totals.dismissedReports,
              total: totals.resolvedReports + totals.dismissedReports,
            },
          },
          daily,
          unavailableMetrics: [...UNAVAILABLE_DASHBOARD_METRICS],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
