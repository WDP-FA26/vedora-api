import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AdminDashboardController } from '../src/admin-dashboard/admin-dashboard.controller.js';
import { AdminDashboardService } from '../src/admin-dashboard/admin-dashboard.service.js';
import { configureApp } from '../src/app.setup.js';
import type { DashboardDto } from '../src/admin-dashboard/dto/dashboard.dto.js';
import { MongoModule } from '../src/mongo/mongo.module.js';
import { MongoService } from '../src/mongo/mongo.service.js';
import {
  AccountStatus,
  Post,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
  Recipe,
  User,
  UserRole,
} from '../src/mongo/models.js';
import { createPost, createRecipe, createUser } from './fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

describe('Admin dashboard with MongoDB', () => {
  let db: MongoService;
  let app: INestApplication<App>;
  let dashboard: AdminDashboardService;
  let token: string;
  let memberToken: string;
  let adminId: string;
  let memberId: string;
  const before = new Date('2026-09-30T16:59:59.999Z');
  const start = new Date('2026-09-30T17:00:00.000Z');
  const secondDay = new Date('2026-10-01T17:00:00.000Z');
  const end = new Date('2026-10-02T17:00:00.000Z');
  const query = { from: '2026-10-01', to: '2026-10-02' };
  const path = '/api/v1/admin/dashboard';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('dashboard')),
        JwtModule.register({
          secret: 'dashboard-mongodb-integration-secret',
        }),
      ],
      controllers: [AdminDashboardController],
      providers: [
        AdminDashboardService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get(MongoService);
    await prepareTestDatabase(app);
    dashboard = app.get(AdminDashboardService);
    const makeUser = (
      name: string,
      status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_EMAIL' | 'DELETED',
      createdAt: Date,
      role: 'USER' | 'ADMIN' = 'USER',
    ) =>
      createUser(db, {
        username: name,
        email: `${name}@dashboard.test`,
        fullName: name,
        role: role as UserRole,
        status: status as AccountStatus,
        createdAt,
        emailVerifiedAt: status === 'PENDING_EMAIL' ? null : before,
      });
    const admin = await makeUser('dashboard.admin', 'ACTIVE', start, 'ADMIN');
    adminId = admin.id;
    const member = await makeUser('dashboard.before', 'ACTIVE', before);
    memberId = member.id;
    await makeUser('dashboard.first', 'ACTIVE', start);
    await makeUser(
      'dashboard.last',
      'SUSPENDED',
      new Date(secondDay.getTime() - 1),
    );
    await makeUser('dashboard.second', 'PENDING_EMAIL', secondDay);
    await makeUser('dashboard.after', 'ACTIVE', end);
    await makeUser('dashboard.deleted', 'DELETED', start);
    const jwt = app.get(JwtService);
    token = await jwt.signAsync({ sub: adminId, username: admin.username });
    memberToken = await jwt.signAsync({
      sub: memberId,
      username: member.username,
      role: 'ADMIN',
    });
    for (const [type, publishedAt, status] of [
      ['POST', before, 'PUBLISHED'],
      ['POST', start, 'PUBLISHED'],
      ['POST', secondDay, 'PUBLISHED'],
      ['BLOG', new Date(secondDay.getTime() - 1), 'PUBLISHED'],
      ['POST', end, 'PUBLISHED'],
      ['BLOG', null, 'DRAFT'],
      ['POST', start, 'FAILED'],
    ] as const) {
      await createPost(db, {
        authorId: memberId,
        type: type as PostType,
        status: status as PostStatus,
        publishedAt,
        body: 'dashboard body',
        blog:
          type === 'BLOG'
            ? {
                title: 'Dashboard blog',
                coverImageUrl: null,
                content: 'Content',
                excerpt: 'Content',
                recipeIds: [],
              }
            : null,
      });
    }
    for (const createdAt of [before, start, new Date(end.getTime() - 1), end]) {
      await createRecipe(db, { title: 'Dashboard recipe', createdAt });
    }
    for (const [status, createdAt, reviewedAt] of [
      ['PENDING', before, null],
      ['PENDING', start, null],
      ['RESOLVED', before, secondDay],
      ['DISMISSED', start, start],
      ['RESOLVED', secondDay, end],
      ['PENDING', end, null],
    ] as const) {
      const post = await createPost(db, {
        authorId: memberId,
        publishedAt: before,
        body: 'Report source',
      });
      await db.connection.model<PostReport>(PostReport.name).create({
        _id: randomUUID(),
        postId: post.id,
        reporterId: memberId,
        reason: PostReportReason.OTHER,
        status: status as PostReportStatus,
        createdAt,
        reviewedAt,
        reviewedById: reviewedAt ? adminId : null,
      });
    }
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  it('uses inclusive Bangkok days and keeps snapshot counts separate from period counts', async () => {
    const result = await dashboard.get(query);
    expect(result.range).toEqual({
      ...query,
      dayCount: 2,
      timeZone: 'Asia/Bangkok',
    });
    expect(result.snapshot).toEqual({
      members: { total: 5, active: 3, suspended: 1, pendingEmail: 1 },
      pendingReports: 3,
    });
    expect(result.period).toEqual({
      newMembers: 3,
      publishedContent: { posts: 2, blogs: 1, total: 3 },
      recipesCreated: 2,
      reportsCreated: 3,
      reportDecisions: { resolved: 1, dismissed: 1, total: 2 },
    });
    expect(result.daily).toEqual([
      {
        date: '2026-10-01',
        newMembers: 2,
        publishedPosts: 1,
        publishedBlogs: 1,
        reportsCreated: 2,
        resolvedReports: 0,
        dismissedReports: 1,
      },
      {
        date: '2026-10-02',
        newMembers: 1,
        publishedPosts: 1,
        publishedBlogs: 0,
        reportsCreated: 1,
        resolvedReports: 1,
        dismissedReports: 0,
      },
    ]);
  });

  it('returns zero-filled days for an empty period, while retaining current snapshots', async () => {
    const result = await dashboard.get({
      from: '2026-10-04',
      to: '2026-10-06',
    });
    expect(result.daily.map((day) => day.date)).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(
      result.daily.every((day) =>
        Object.entries(day).every(
          ([key, value]) => key === 'date' || value === 0,
        ),
      ),
    ).toBe(true);
    expect(result.period.newMembers).toBe(0);
    expect(result.snapshot.pendingReports).toBe(3);
    expect(result.unavailableMetrics).toEqual([
      'MODERATION_CASE_SEVERITY',
      'CONTENT_APPROVALS',
      'PAYMENT_DEMO',
    ]);
  });

  it('returns aggregates over HTTP without private account or post data', async () => {
    const response = await request(app.getHttpServer())
      .get(`${path}?from=${query.from}&to=${query.to}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const result = response.body as DashboardDto;
    expect(result.period.publishedContent.total).toBe(3);
    const text = JSON.stringify(result);
    expect(text).not.toContain('@dashboard.test');
    expect(text).not.toContain(adminId);
    expect(text).not.toContain('dashboard body');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('requires auth and does not trust a member token claiming ADMIN', async () => {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .get(path)
      .auth(memberToken, { type: 'bearer' })
      .expect(403);
  });

  it('blocks a suspended administrator with the same unexpired JWT', async () => {
    const users = db.connection.model<User>(User.name);
    await users
      .updateOne(
        { _id: adminId },
        { $set: { status: AccountStatus.SUSPENDED } },
      )
      .exec();
    try {
      await request(app.getHttpServer())
        .get(path)
        .auth(token, { type: 'bearer' })
        .expect(401);
    } finally {
      await users
        .updateOne({ _id: adminId }, { $set: { status: AccountStatus.ACTIVE } })
        .exec();
    }
  });

  it('does not mutate any underlying domain records', async () => {
    const snapshot = async () => ({
      users: await db.connection
        .model<User>(User.name)
        .find({})
        .sort({ _id: 1 })
        .lean()
        .exec(),
      posts: await db.connection
        .model<Post>(Post.name)
        .find({})
        .sort({ _id: 1 })
        .lean()
        .exec(),
      reports: await db.connection
        .model<PostReport>(PostReport.name)
        .find({})
        .sort({ _id: 1 })
        .lean()
        .exec(),
      recipes: await db.connection
        .model<Recipe>(Recipe.name)
        .find({})
        .sort({ _id: 1 })
        .lean()
        .exec(),
    });
    const beforeQuery = await snapshot();
    await dashboard.get(query);
    expect(await snapshot()).toEqual(beforeQuery);
  });

  it('accepts the maximum inclusive range and rejects 91 days', async () => {
    expect(
      (await dashboard.get({ from: '2024-01-01', to: '2024-03-30' })).daily,
    ).toHaveLength(90);
    await request(app.getHttpServer())
      .get(`${path}?from=2024-01-01&to=2024-03-31`)
      .auth(token, { type: 'bearer' })
      .expect(400);
  });
});
