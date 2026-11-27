import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { runtimeConfig } from '../../config/runtime-config.js';
import { zonedMidnight } from '../../config/time-zone.js';
import {
  DAY_MS,
  resolveDashboardRange,
  type DashboardRange,
} from '../../admin-dashboard/dashboard-range.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
} from '../../common/pagination/index.js';
import {
  Follow,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  PostStatus,
  PostType,
  PostViewDay,
} from '../../mongo/models.js';
import type {
  ListPostAnalyticsQueryDto,
  PostAnalyticsCountsDto,
  PostAnalyticsDayDto,
  PostAnalyticsItemDto,
  PostAnalyticsPageDto,
  PostAnalyticsRangeDto,
  PostAnalyticsRangeQueryDto,
  PostAnalyticsSort,
  PostAnalyticsSummaryDto,
  PostAnalyticsTotalsDto,
} from './dto/post-analytics.dto.js';

const TITLE_LENGTH = 140;
const TIME_ZONE = runtimeConfig.APP_TIMEZONE;

const COUNT_METRICS = [
  'likes',
  'comments',
  'reposts',
  'saves',
  'newFollowers',
  'publishedPosts',
] as const;
type CountMetric = (typeof COUNT_METRICS)[number];
type DailyCounts = Record<CountMetric, Map<string, number>>;

type Bounds = { $gte: Date; $lt: Date };
type GroupCount = { _id: string; count: number };
type Aggregator = {
  aggregate<T>(pipeline: PipelineStage[]): { exec(): Promise<T[]> };
};

type AuthorPost = Pick<
  Post,
  '_id' | 'type' | 'body' | 'blog' | 'publishedAt' | 'viewCount'
>;

interface Window {
  current: DashboardRange;
  previous: { from: string; to: string; dates: string[] };
  bounds: Bounds;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function datesFrom(from: string, dayCount: number): string[] {
  const dates: string[] = [];
  for (let index = 0; index < dayCount; index += 1) {
    dates.push(addDays(from, index));
  }
  return dates;
}

function toCountMap(groups: GroupCount[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    if (!Number.isSafeInteger(group.count))
      throw new Error('Analytics aggregate exceeds safe integer range');
    counts.set(group._id, group.count);
  }
  return counts;
}

function countBy(
  key: { dateField: string } | { field: string },
  match: Record<string, unknown>,
): PipelineStage[] {
  const groupKey =
    'dateField' in key
      ? {
          $dateToString: {
            format: '%Y-%m-%d',
            date: `$${key.dateField}`,
            timezone: TIME_ZONE,
          },
        }
      : `$${key.field}`;
  return [{ $match: match }, { $group: { _id: groupKey, count: { $sum: 1 } } }];
}

function sumBy(field: string, match: Record<string, unknown>): PipelineStage[] {
  return [
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: '$count' } } },
  ];
}

function publicRange(range: DashboardRange): PostAnalyticsRangeDto {
  return {
    from: range.from,
    to: range.to,
    timeZone: range.timeZone,
    dayCount: range.dayCount,
  };
}

function postTitle(post: AuthorPost): string | null {
  if (post.type === PostType.BLOG && post.blog) return post.blog.title;
  const body = post.body?.trim() ?? '';
  if (body === '') return null;
  if (body.length <= TITLE_LENGTH) return body;
  return `${body.slice(0, TITLE_LENGTH).trimEnd()}…`;
}

function publishedTime(post: AuthorPost): number {
  return post.publishedAt?.getTime() ?? 0;
}

function compareNewestFirst(a: AuthorPost, b: AuthorPost): number {
  const byTime = publishedTime(b) - publishedTime(a);
  if (byTime !== 0) return byTime;
  if (a._id === b._id) return 0;
  return a._id < b._id ? 1 : -1;
}

@Injectable()
export class PostAnalyticsService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostRepost.name) private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(PostViewDay.name)
    private readonly viewDays: Model<PostViewDay>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
  ) {}

  async summary(
    userId: string,
    query: PostAnalyticsRangeQueryDto,
  ): Promise<PostAnalyticsSummaryDto> {
    const window = this.window(query);
    const authorPosts = await this.publishedPosts(userId);
    const postIds = authorPosts.map((post) => post._id);
    const [counts, views, viewsTrackedSince, followers] = await Promise.all([
      this.dailyCounts(userId, postIds, window.bounds),
      this.dailyViews(userId, postIds, window.previous.from, window.current.to),
      this.viewsTrackedSince(),
      this.follows.countDocuments({ followingId: userId }).exec(),
    ]);

    let lifetimeViews = 0;
    for (const post of authorPosts) lifetimeViews += post.viewCount;

    const currentDates = datesFrom(
      window.current.from,
      window.current.dayCount,
    );
    const daily = currentDates.map((date) =>
      this.day(date, counts, views, viewsTrackedSince),
    );
    const previousDays = window.previous.dates.map((date) =>
      this.day(date, counts, views, viewsTrackedSince),
    );

    return {
      generatedAt: new Date().toISOString(),
      range: publicRange(window.current),
      previousRange: { from: window.previous.from, to: window.previous.to },
      viewsTrackedSince,
      snapshot: {
        followers,
        publishedPosts: authorPosts.length,
        lifetimeViews,
      },
      current: this.totals(daily),
      previous: this.totals(previousDays),
      daily,
      previousDaily: previousDays,
    };
  }

  async listPosts(
    userId: string,
    query: ListPostAnalyticsQueryDto,
  ): Promise<PostAnalyticsPageDto> {
    const range = resolveDashboardRange(query);
    const bounds = { $gte: range.start, $lt: range.endExclusive };
    const authorPosts = await this.publishedPosts(userId);
    const postIds = authorPosts.map((post) => post._id);
    const counts = await this.perPostCounts(userId, postIds, bounds, range);

    const rows = authorPosts.map((post) => ({
      post,
      period: counts.get(post._id) ?? this.emptyPostCounts(),
    }));
    rows.sort((a, b) => {
      const byMetric = this.compareMetric(query.sort, a.period, b.period);
      if (byMetric !== 0) return byMetric;
      return compareNewestFirst(a.post, b.post);
    });

    const { skip, take } = getPaginationArgs(query);
    const items: PostAnalyticsItemDto[] = [];
    for (const { post, period } of rows.slice(skip, skip + take)) {
      items.push({
        id: post._id,
        type: post.type,
        title: postTitle(post),
        publishedAt: post.publishedAt?.toISOString() ?? null,
        lifetimeViews: post.viewCount,
        period,
      });
    }
    return {
      ...createPaginatedResponse(items, rows.length, query),
      range: publicRange(range),
    };
  }

  private window(query: PostAnalyticsRangeQueryDto): Window {
    const current = resolveDashboardRange(query);
    const previousFrom = addDays(current.from, -current.dayCount);
    const previousTo = addDays(current.from, -1);
    return {
      current,
      previous: {
        from: previousFrom,
        to: previousTo,
        dates: datesFrom(previousFrom, current.dayCount),
      },
      bounds: {
        $gte: zonedMidnight(previousFrom, TIME_ZONE),
        $lt: current.endExclusive,
      },
    };
  }

  private publishedPosts(userId: string): Promise<AuthorPost[]> {
    return this.posts
      .find({ authorId: userId, status: PostStatus.PUBLISHED })
      .select('_id type body blog.title publishedAt viewCount')
      .lean<AuthorPost[]>()
      .exec();
  }

  private groups(
    model: Aggregator,
    pipeline: PipelineStage[],
  ): Promise<Map<string, number>> {
    return model.aggregate<GroupCount>(pipeline).exec().then(toCountMap);
  }

  private interactionMatches(
    userId: string,
    postIds: string[],
    bounds: Bounds,
  ) {
    const onPosts = { postId: { $in: postIds }, createdAt: bounds };
    const byOthers = { ...onPosts, userId: { $ne: userId } };
    return {
      likes: { model: this.likes, match: byOthers },
      comments: {
        model: this.comments,
        match: { ...onPosts, authorId: { $ne: userId } },
      },
      reposts: { model: this.reposts, match: byOthers },
      saves: { model: this.bookmarks, match: byOthers },
    };
  }

  private async dailyCounts(
    userId: string,
    postIds: string[],
    bounds: Bounds,
  ): Promise<DailyCounts> {
    const byDay = { dateField: 'createdAt' };
    const interactions = this.interactionMatches(userId, postIds, bounds);
    const [likes, comments, reposts, saves, newFollowers] = await Promise.all([
      this.groups(
        interactions.likes.model,
        countBy(byDay, interactions.likes.match),
      ),
      this.groups(
        interactions.comments.model,
        countBy(byDay, interactions.comments.match),
      ),
      this.groups(
        interactions.reposts.model,
        countBy(byDay, interactions.reposts.match),
      ),
      this.groups(
        interactions.saves.model,
        countBy(byDay, interactions.saves.match),
      ),
      this.groups(
        this.follows,
        countBy(byDay, { followingId: userId, createdAt: bounds }),
      ),
    ]);
    const publishedPosts = await this.groups(
      this.posts,
      countBy(
        { dateField: 'publishedAt' },
        {
          authorId: userId,
          status: PostStatus.PUBLISHED,
          publishedAt: bounds,
        },
      ),
    );
    return {
      likes,
      comments,
      reposts,
      saves,
      newFollowers,
      publishedPosts,
    };
  }

  private dailyViews(
    userId: string,
    postIds: string[],
    from: string,
    to: string,
  ): Promise<Map<string, number>> {
    return this.groups(
      this.viewDays,
      sumBy('date', {
        authorId: userId,
        postId: { $in: postIds },
        date: { $gte: from, $lte: to },
      }),
    );
  }

  private async viewsTrackedSince(): Promise<string | null> {
    const first = await this.viewDays
      .findOne()
      .sort({ date: 1 })
      .select('date')
      .lean()
      .exec();
    return first?.date ?? null;
  }

  private day(
    date: string,
    counts: DailyCounts,
    views: Map<string, number>,
    trackedSince: string | null,
  ): PostAnalyticsDayDto {
    const tracked = trackedSince !== null && date >= trackedSince;
    const row: PostAnalyticsDayDto = {
      date,
      views: tracked ? (views.get(date) ?? 0) : null,
      likes: 0,
      comments: 0,
      reposts: 0,
      saves: 0,
      newFollowers: 0,
      publishedPosts: 0,
    };
    for (const metric of COUNT_METRICS) {
      row[metric] = counts[metric].get(date) ?? 0;
    }
    return row;
  }

  private totals(days: PostAnalyticsDayDto[]): PostAnalyticsTotalsDto {
    const totals: PostAnalyticsTotalsDto = {
      views: 0,
      viewsComplete: true,
      likes: 0,
      comments: 0,
      reposts: 0,
      saves: 0,
      newFollowers: 0,
      publishedPosts: 0,
    };
    for (const day of days) {
      if (day.views === null) {
        totals.viewsComplete = false;
      } else {
        totals.views += day.views;
      }
      for (const metric of COUNT_METRICS) totals[metric] += day[metric];
    }
    return totals;
  }

  private emptyPostCounts(): PostAnalyticsCountsDto {
    return { views: 0, likes: 0, comments: 0, reposts: 0, saves: 0 };
  }

  private async perPostCounts(
    userId: string,
    postIds: string[],
    bounds: Bounds,
    range: DashboardRange,
  ): Promise<Map<string, PostAnalyticsCountsDto>> {
    const byPost = { field: 'postId' };
    const interactions = this.interactionMatches(userId, postIds, bounds);
    const [views, likes, comments, reposts, saves] = await Promise.all([
      this.groups(
        this.viewDays,
        sumBy('postId', {
          authorId: userId,
          postId: { $in: postIds },
          date: { $gte: range.from, $lte: range.to },
        }),
      ),
      this.groups(
        interactions.likes.model,
        countBy(byPost, interactions.likes.match),
      ),
      this.groups(
        interactions.comments.model,
        countBy(byPost, interactions.comments.match),
      ),
      this.groups(
        interactions.reposts.model,
        countBy(byPost, interactions.reposts.match),
      ),
      this.groups(
        interactions.saves.model,
        countBy(byPost, interactions.saves.match),
      ),
    ]);
    const result = new Map<string, PostAnalyticsCountsDto>();
    for (const postId of postIds) {
      result.set(postId, {
        views: views.get(postId) ?? 0,
        likes: likes.get(postId) ?? 0,
        comments: comments.get(postId) ?? 0,
        reposts: reposts.get(postId) ?? 0,
        saves: saves.get(postId) ?? 0,
      });
    }
    return result;
  }

  private compareMetric(
    sort: PostAnalyticsSort,
    a: PostAnalyticsCountsDto,
    b: PostAnalyticsCountsDto,
  ): number {
    if (sort === 'recent') return 0;
    return b[sort] - a[sort];
  }
}
