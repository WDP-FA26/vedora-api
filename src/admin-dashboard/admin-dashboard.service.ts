import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Document } from 'mongodb';
import type { Model } from 'mongoose';
import {
  AccountStatus,
  Post,
  PostReport,
  PostReportStatus,
  PostStatus,
  PostType,
  Recipe,
  User,
  UserRole,
} from '../mongo/models';
import { DAY_MS, resolveDashboardRange } from './dashboard-range';
import {
  DashboardDayDto,
  DashboardDto,
  DashboardQueryDto,
  UNAVAILABLE_DASHBOARD_METRICS,
} from './dto/dashboard.dto';

type DayCounts = Omit<DashboardDayDto, 'date'>;
type DatabaseDay = { date: string } & Record<keyof DayCounts, number>;
type DayCount = { _id: string; count: number };
type StatusCount = { _id: AccountStatus; count: number };
type DayAggregator = {
  aggregate<T>(pipeline: Document[]): { exec(): Promise<T[]> };
};

/** Pipeline counting the matching documents per Asia/Bangkok calendar day. */
const dailyCounts = (dateField: string, match: Document): Document[] => [
  { $match: match },
  {
    $group: {
      _id: {
        $dateToString: {
          format: '%Y-%m-%d',
          date: `$${dateField}`,
          timezone: 'Asia/Bangkok',
        },
      },
      count: { $sum: 1 },
    },
  },
];

/** Joins the per-event results (`[{ _id: 'YYYY-MM-DD', count }]`) by day. */
function mergeDays(
  results: Record<keyof DayCounts, DayCount[]>,
): DatabaseDay[] {
  const days = new Map<string, DatabaseDay>();
  for (const key of Object.keys(results) as (keyof DayCounts)[]) {
    for (const entry of results[key]) {
      const row = days.get(entry._id) ?? {
        date: entry._id,
        ...emptyCounts(),
      };
      row[key] = entry.count;
      days.set(entry._id, row);
    }
  }
  return [...days.values()];
}
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
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostReport.name)
    private readonly postReports: Model<PostReport>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
  ) {}

  async get(query: DashboardQueryDto): Promise<DashboardDto> {
    const range = resolveDashboardRange(query);
    const { start, endExclusive, ...publicRange } = range;
    {
      const members = await this.users
        .aggregate<StatusCount>([
          {
            $match: {
              role: UserRole.USER,
              status: { $ne: AccountStatus.DELETED },
            },
          },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .exec();
      const pendingReports = await this.postReports
        .countDocuments({ status: PostReportStatus.PENDING })
        .exec();
      const recipesCreated = await this.recipes
        .countDocuments({ createdAt: { $gte: start, $lt: endExclusive } })
        .exec();
      // Only aggregate values cross the DB boundary: each event kind is
      // grouped by Asia/Bangkok day in the database; there is no per-day
      // query or PII.
      const bounds = { $gte: start, $lt: endExclusive };
      const days = (
        model: DayAggregator,
        pipeline: Document[],
      ): Promise<DayCount[]> => model.aggregate<DayCount>(pipeline).exec();
      const [
        newMembers,
        publishedPosts,
        publishedBlogs,
        reportsCreated,
        resolvedReports,
        dismissedReports,
      ] = await Promise.all([
        days(
          this.users,
          dailyCounts('createdAt', {
            role: UserRole.USER,
            status: { $ne: AccountStatus.DELETED },
            createdAt: bounds,
          }),
        ),
        days(
          this.posts,
          dailyCounts('publishedAt', {
            status: PostStatus.PUBLISHED,
            type: PostType.POST,
            publishedAt: bounds,
          }),
        ),
        days(
          this.posts,
          dailyCounts('publishedAt', {
            status: PostStatus.PUBLISHED,
            type: PostType.BLOG,
            publishedAt: bounds,
          }),
        ),
        days(this.postReports, dailyCounts('createdAt', { createdAt: bounds })),
        days(
          this.postReports,
          dailyCounts('reviewedAt', {
            status: PostReportStatus.RESOLVED,
            reviewedAt: bounds,
          }),
        ),
        days(
          this.postReports,
          dailyCounts('reviewedAt', {
            status: PostReportStatus.DISMISSED,
            reviewedAt: bounds,
          }),
        ),
      ]);
      const rows = mergeDays({
        newMembers,
        publishedPosts,
        publishedBlogs,
        reportsCreated,
        resolvedReports,
        dismissedReports,
      });
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
              throw new Error('Dashboard aggregate exceeds safe integer range');
            counts[key] = value;
            totals[key] += value;
          }
          return { date, ...counts };
        },
      );
      const count = (status: AccountStatus) =>
        members.find((group) => group._id === status)?.count ?? 0;
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
    }
  }
}
