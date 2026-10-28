import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import {
  AccountStatus,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostType,
  type User,
  UserRole,
} from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createPost, createRecipe, createUser } from './fixtures.js';

describe('Admin dashboard (HTTP)', () => {
  let e2e: E2eApp;
  let admin: User;
  let token: string;
  const route = '/api/v1/admin/dashboard';
  // Noon in Bangkok on 2026-10-02.
  const october2 = new Date('2026-10-02T05:00:00Z');

  beforeAll(async () => {
    e2e = await createE2eApp('dashboard_e2e');
    admin = await createUser(e2e.mongo, {
      username: 'admin',
      role: UserRole.ADMIN,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    token = await e2e.sign(admin);
  });
  afterAll(async () => e2e?.close());

  const get = (query = '', bearer = token) =>
    request(e2e.app.getHttpServer())
      .get(query ? `${route}?${query}` : route)
      .auth(bearer, { type: 'bearer' });

  it('requires authentication', async () => {
    await request(e2e.app.getHttpServer()).get(route).expect(401);
  });

  it('rejects members even when a signed token claims ADMIN', async () => {
    const member = await createUser(e2e.mongo, { username: 'member' });
    const claimed = await e2e.app
      .get(JwtService)
      .signAsync({ sub: member.id, username: 'member', role: 'ADMIN' });
    await get('', claimed).expect(403);
  });

  it('rejects suspended administrators', async () => {
    const suspended = await createUser(e2e.mongo, {
      username: 'suspended.admin',
      role: UserRole.ADMIN,
      status: AccountStatus.SUSPENDED,
    });
    await get('', await e2e.sign(suspended)).expect(401);
  });

  it('returns a private default dashboard with explicit unavailable metrics', async () => {
    const response = await get().expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.vary).toContain('Authorization');
    expect(response.body).toMatchObject({
      range: { timeZone: 'Asia/Bangkok', dayCount: 30 },
      snapshot: { pendingReports: 0 },
      unavailableMetrics: [
        'MODERATION_CASE_SEVERITY',
        'CONTENT_APPROVALS',
        'PAYMENT_DEMO',
      ],
    });
  });

  it('fills missing days with actual zero counts from the daily aggregates', async () => {
    const author = await createUser(e2e.mongo, {
      username: 'dashboard.author',
      createdAt: october2,
    });
    await createUser(e2e.mongo, {
      username: 'october.2',
      createdAt: october2,
    });
    await createPost(e2e.mongo, {
      authorId: author.id,
      publishedAt: october2,
    });
    for (let index = 0; index < 3; index++) {
      await createPost(e2e.mongo, {
        authorId: author.id,
        type: PostType.BLOG,
        publishedAt: october2,
        blog: {
          title: 'Blog',
          coverImageUrl: null,
          content: 'Content',
          excerpt: 'Content',
          recipeIds: [],
        },
      });
    }
    const reported = await createPost(e2e.mongo, {
      authorId: author.id,
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    });
    for (const [status, reviewedAt] of [
      ['PENDING', null],
      ['RESOLVED', october2],
      ['DISMISSED', october2],
      ['DISMISSED', october2],
    ] as const) {
      const reporter = await createUser(e2e.mongo);
      await e2e.mongo.connection.model<PostReport>(PostReport.name).create({
        _id: randomUUID(),
        postId: reported.id,
        reporterId: reporter.id,
        reason: PostReportReason.OTHER,
        status: status as PostReportStatus,
        createdAt: october2,
        reviewedAt,
        reviewedById: reviewedAt ? admin.id : null,
      });
    }
    // The range is Bangkok days, so 17:00 UTC is the boundary.
    await createRecipe(e2e.mongo, {
      createdAt: new Date('2026-09-30T17:00:00Z'),
    });
    await createRecipe(e2e.mongo, {
      createdAt: new Date('2026-10-03T17:00:00Z'),
    });

    const response = await get('from=2026-10-01&to=2026-10-03').expect(200);
    expect(response.body).toMatchObject({
      period: {
        // The four reporters joined today, outside the range.
        newMembers: 2,
        publishedContent: { posts: 1, blogs: 3, total: 4 },
        recipesCreated: 1,
        reportsCreated: 4,
        reportDecisions: { resolved: 1, dismissed: 2, total: 3 },
      },
      daily: [
        { date: '2026-10-01', newMembers: 0 },
        { date: '2026-10-02', newMembers: 2 },
        { date: '2026-10-03', newMembers: 0 },
      ],
    });
  });

  it.each([
    'from=2026-10-01',
    'to=2026-10-01',
    'from=&to=',
    'from=2026-02-30&to=2026-03-01',
    'from=2026-02-29&to=2026-03-01',
    'from=2026-10-02&to=2026-10-01',
    'from=2024-01-01&to=2024-03-31',
    'from=2026-10-01T00:00:00Z&to=2026-10-02',
    'from=2026-1-01&to=2026-01-02',
    'from=2026-10-01&from=2026-10-02&to=2026-10-03',
    'timezone=UTC',
    'userId=other',
    'include=users',
    'days=91',
  ])('rejects unsupported/invalid query %s', async (query) => {
    await get(query).expect(400);
  });
});
