import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminDashboardController } from '../src/admin-dashboard/admin-dashboard.controller';
import { AdminDashboardService } from '../src/admin-dashboard/admin-dashboard.service';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { DashboardDto } from '../src/admin-dashboard/dto/dashboard.dto';

describe('Admin dashboard with PostgreSQL', () => {
  const schema = `vedora_dashboard_test_${randomUUID().replaceAll('-', '')}`;
  let db: PrismaClient;
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
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'dashboard-postgresql-integration-secret',
        }),
      ],
      controllers: [AdminDashboardController],
      providers: [
        AdminDashboardService,
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    dashboard = app.get(AdminDashboardService);
    const makeUser = (
      name: string,
      status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_EMAIL' | 'DELETED',
      createdAt: Date,
      role: 'USER' | 'ADMIN' = 'USER',
    ) =>
      db.user.create({
        data: {
          username: name,
          email: `${name}@dashboard.test`,
          fullName: name,
          role,
          status,
          createdAt,
          emailVerifiedAt: status === 'PENDING_EMAIL' ? null : before,
        },
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
      await db.post.create({
        data: {
          authorId: memberId,
          type,
          status,
          publishedAt,
          body: 'dashboard body',
          ...(type === 'BLOG'
            ? {
                blog: {
                  create: {
                    title: 'Dashboard blog',
                    content: 'Content',
                    excerpt: 'Content',
                  },
                },
              }
            : {}),
        },
      });
    }
    for (const createdAt of [before, start, new Date(end.getTime() - 1), end]) {
      await db.recipe.create({
        data: {
          title: 'Dashboard recipe',
          servings: 2,
          steps: ['Cook'],
          createdAt,
        },
      });
    }
    for (const [status, createdAt, reviewedAt] of [
      ['PENDING', before, null],
      ['PENDING', start, null],
      ['RESOLVED', before, secondDay],
      ['DISMISSED', start, start],
      ['RESOLVED', secondDay, end],
      ['PENDING', end, null],
    ] as const) {
      const post = await db.post.create({
        data: {
          authorId: memberId,
          status: 'PUBLISHED',
          publishedAt: before,
          body: 'Report source',
        },
      });
      await db.postReport.create({
        data: {
          postId: post.id,
          reporterId: memberId,
          reason: 'OTHER',
          status,
          createdAt,
          reviewedAt,
          reviewedById: reviewedAt ? adminId : null,
        },
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.$disconnect();
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
    await db.user.update({
      where: { id: adminId },
      data: { status: 'SUSPENDED' },
    });
    try {
      await request(app.getHttpServer())
        .get(path)
        .auth(token, { type: 'bearer' })
        .expect(401);
    } finally {
      await db.user.update({
        where: { id: adminId },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('does not mutate any underlying domain records', async () => {
    const snapshot = async () => ({
      users: await db.user.findMany({ orderBy: { id: 'asc' } }),
      posts: await db.post.findMany({ orderBy: { id: 'asc' } }),
      reports: await db.postReport.findMany({ orderBy: { id: 'asc' } }),
      recipes: await db.recipe.findMany({ orderBy: { id: 'asc' } }),
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
