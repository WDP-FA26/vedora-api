import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  type Follow,
  type PostBookmark,
  type PostComment,
  type PostLike,
  type PostRepost,
  PostStatus,
  type PostViewDay,
  type User,
} from '@src/mongo/models.js';
import type {
  PostAnalyticsPageDto,
  PostAnalyticsSummaryDto,
} from '@src/posts/analytics/dto/post-analytics.dto.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

/** Midday in Bangkok (UTC+7) on the given day. */
const at = (day: string) => new Date(`${day}T05:00:00Z`);

describe('Post analytics (HTTP)', () => {
  let e2e: E2eApp;
  let author: User;
  let token: string;
  let mainPostId: string;
  let quietPostId: string;
  const range = 'from=2026-10-01&to=2026-10-07';

  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const get = (path: string, bearer = token) =>
    request(e2e.app.getHttpServer())
      .get(`/api/v1/analytics/posts${path}`)
      .auth(bearer, { type: 'bearer' });

  beforeAll(async () => {
    e2e = await createE2eApp('post_analytics_e2e');
    author = await createUser(e2e.mongo, { username: 'analytics.author' });
    token = await e2e.sign(author);
    const fan = await createUser(e2e.mongo, { username: 'analytics.fan' });
    const friend = await createUser(e2e.mongo, {
      username: 'analytics.friend',
    });

    const main = await createPost(e2e.mongo, {
      authorId: author.id,
      body: 'Canh chua chay '.repeat(20),
      publishedAt: at('2026-10-02'),
      viewCount: 40,
    });
    const quiet = await createPost(e2e.mongo, {
      authorId: author.id,
      body: 'Đậu hũ sốt cà',
      publishedAt: at('2026-10-06'),
      viewCount: 2,
    });
    const removed = await createPost(e2e.mongo, {
      authorId: author.id,
      body: 'removed',
      status: PostStatus.REMOVED,
      publishedAt: at('2026-10-02'),
      viewCount: 99,
    });
    const othersPost = await createPost(e2e.mongo, {
      authorId: fan.id,
      body: 'not mine',
      publishedAt: at('2026-10-02'),
    });
    mainPostId = main.id;
    quietPostId = quiet.id;

    const interaction = (postId: string, userId: string, day: Date) => ({
      _id: randomUUID(),
      postId,
      userId,
      createdAt: day,
    });
    await model<PostLike>('PostLike').insertMany([
      interaction(main.id, fan.id, at('2026-10-02')),
      interaction(main.id, friend.id, at('2026-09-25')),
      interaction(main.id, author.id, at('2026-10-02')),
      interaction(removed.id, fan.id, at('2026-10-02')),
      interaction(othersPost.id, friend.id, at('2026-10-02')),
    ]);
    // 00:30 on 8 October in Bangkok: outside the range.
    await model<PostRepost>('PostRepost').insertMany([
      interaction(main.id, friend.id, at('2026-10-04')),
      interaction(quiet.id, fan.id, new Date('2026-10-07T17:30:00Z')),
    ]);
    await model<PostBookmark>('PostBookmark').insertMany([
      interaction(main.id, fan.id, at('2026-10-04')),
      interaction(quiet.id, friend.id, at('2026-10-06')),
      interaction(quiet.id, fan.id, at('2026-10-06')),
    ]);
    await model<PostComment>('PostComment').insertMany([
      {
        _id: randomUUID(),
        postId: main.id,
        authorId: fan.id,
        body: 'Ngon quá',
        createdAt: at('2026-10-03'),
      },
      {
        _id: randomUUID(),
        postId: main.id,
        authorId: author.id,
        body: 'Cảm ơn',
        createdAt: at('2026-10-03'),
      },
    ]);
    await model<Follow>('Follow').insertMany([
      {
        _id: randomUUID(),
        followerId: fan.id,
        followingId: author.id,
        createdAt: at('2026-10-01'),
      },
      {
        _id: randomUUID(),
        followerId: friend.id,
        followingId: author.id,
        createdAt: at('2026-09-28'),
      },
    ]);
    const viewDay = (postId: string, date: string, count: number) => ({
      _id: randomUUID(),
      postId,
      authorId: author.id,
      date,
      count,
    });
    await model<PostViewDay>('PostViewDay').insertMany([
      viewDay(main.id, '2026-10-03', 5),
      viewDay(main.id, '2026-10-05', 2),
      viewDay(quiet.id, '2026-10-06', 1),
      viewDay(removed.id, '2026-10-05', 50),
    ]);
  });
  afterAll(async () => e2e?.close());

  it('requires authentication', async () => {
    await request(e2e.app.getHttpServer())
      .get('/api/v1/analytics/posts/summary')
      .expect(401);
    await request(e2e.app.getHttpServer())
      .get('/api/v1/analytics/posts')
      .expect(401);
  });

  it('rejects partial, reversed, too long and unknown query fields', async () => {
    await get('/summary?from=2026-10-01').expect(400);
    await get('/summary?from=2026-10-07&to=2026-10-01').expect(400);
    await get('/summary?from=2026-01-01&to=2026-10-01').expect(400);
    await get(`/summary?${range}&userId=${randomUUID()}`).expect(400);
    await get(`?${range}&sort=random`).expect(400);
  });

  it("sums other people's activity on the caller's published posts, by Bangkok day", async () => {
    const response = await get(`/summary?${range}`).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      range: {
        from: '2026-10-01',
        to: '2026-10-07',
        timeZone: 'Asia/Bangkok',
        dayCount: 7,
      },
      previousRange: { from: '2026-09-24', to: '2026-09-30' },
      viewsTrackedSince: '2026-10-03',
      snapshot: { followers: 2, publishedPosts: 2, lifetimeViews: 42 },
      current: {
        views: 8,
        viewsComplete: false,
        likes: 1,
        comments: 1,
        reposts: 1,
        saves: 3,
        newFollowers: 1,
        publishedPosts: 2,
      },
      previous: {
        views: 0,
        viewsComplete: false,
        likes: 1,
        newFollowers: 1,
        publishedPosts: 0,
      },
    });

    const days = (response.body as PostAnalyticsSummaryDto).daily;
    expect(days.map((day) => day.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(days.map((day) => day.views)).toEqual([null, null, 5, 0, 2, 1, 0]);
    const previousDays = (response.body as PostAnalyticsSummaryDto)
      .previousDaily;
    expect(previousDays).toHaveLength(7);
    expect(previousDays[0].date).toBe('2026-09-24');
    expect(previousDays[1]).toMatchObject({ date: '2026-09-25', likes: 1 });
    expect(previousDays[4]).toMatchObject({
      date: '2026-09-28',
      newFollowers: 1,
    });
    expect(days[3]).toMatchObject({
      date: '2026-10-04',
      saves: 1,
      reposts: 1,
      likes: 0,
    });
  });

  it('shows another user only their own numbers', async () => {
    const stranger = await createUser(e2e.mongo);
    const response = await get(
      `/summary?${range}`,
      await e2e.sign(stranger),
    ).expect(200);
    const summary = response.body as PostAnalyticsSummaryDto;
    expect(summary.snapshot).toEqual({
      followers: 0,
      publishedPosts: 0,
      lifetimeViews: 0,
    });
    expect(summary.current).toMatchObject({
      views: 0,
      likes: 0,
      saves: 0,
    });
  });

  it('lists published posts newest first with counts in the range', async () => {
    const response = await get(`?${range}`).expect(200);
    const page = response.body as PostAnalyticsPageDto;
    expect(page.meta).toMatchObject({ totalItems: 2, page: 1 });
    const [first, second] = page.items;
    expect(first).toMatchObject({
      id: quietPostId,
      title: 'Đậu hũ sốt cà',
      lifetimeViews: 2,
      period: { views: 1, likes: 0, saves: 2, reposts: 0 },
    });
    expect(second).toMatchObject({
      id: mainPostId,
      lifetimeViews: 40,
      period: { views: 7, likes: 1, comments: 1, reposts: 1, saves: 1 },
    });
    expect(second.title?.length).toBeLessThanOrEqual(141);
    expect(second.title?.endsWith('…')).toBe(true);
  });

  it('sorts by a count and pages with the same filter', async () => {
    const byViews = (await get(`?${range}&sort=views&limit=1`).expect(200))
      .body as PostAnalyticsPageDto;
    expect(byViews.items.map((item) => item.id)).toEqual([mainPostId]);
    expect(byViews.meta).toMatchObject({
      totalItems: 2,
      totalPages: 2,
      hasNextPage: true,
    });

    const bySaves = (await get(`?${range}&sort=saves`).expect(200))
      .body as PostAnalyticsPageDto;
    expect(bySaves.items[0].id).toBe(quietPostId);
  });
});
