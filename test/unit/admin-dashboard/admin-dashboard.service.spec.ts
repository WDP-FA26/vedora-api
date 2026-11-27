import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminDashboardService } from '@src/admin-dashboard/admin-dashboard.service.js';
import { UNAVAILABLE_DASHBOARD_METRICS } from '@src/admin-dashboard/dto/dashboard.dto.js';
import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import {
  AccountStatus,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
  UserRole,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  createPost,
  createRecipe,
  createUser,
} from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

describe('AdminDashboardService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AdminDashboardService;
  let memberId: string;
  let adminId: string;

  const before = new Date('2026-09-30T16:59:59.999Z');
  const day1Start = new Date('2026-09-30T17:00:00.000Z');
  const day2Start = new Date('2026-10-01T17:00:00.000Z');
  const after = new Date('2026-10-02T17:00:00.000Z');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('admin_dash_unit'))],
      providers: [AdminDashboardService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AdminDashboardService);

    const admin = await createUser(db, {
      username: 'dash.admin',
      role: UserRole.ADMIN,
      createdAt: day1Start,
    });
    adminId = admin.id;
    const member = await createUser(db, {
      username: 'dash.before',
      status: AccountStatus.ACTIVE,
      createdAt: before,
    });
    memberId = member.id;
    await createUser(db, {
      username: 'dash.day1',
      status: AccountStatus.SUSPENDED,
      createdAt: day1Start,
    });
    await createUser(db, {
      username: 'dash.day2',
      status: AccountStatus.PENDING_EMAIL,
      emailVerifiedAt: null,
      createdAt: day2Start,
    });
    await createUser(db, {
      username: 'dash.deleted',
      status: AccountStatus.DELETED,
      createdAt: day1Start,
    });
    await createUser(db, {
      username: 'dash.after',
      status: AccountStatus.ACTIVE,
      createdAt: after,
    });

    await createPost(db, {
      authorId: memberId,
      type: PostType.POST,
      status: PostStatus.PUBLISHED,
      publishedAt: before,
    });
    await createPost(db, {
      authorId: memberId,
      type: PostType.POST,
      status: PostStatus.PUBLISHED,
      publishedAt: day1Start,
    });
    await createPost(db, {
      authorId: memberId,
      type: PostType.BLOG,
      status: PostStatus.PUBLISHED,
      publishedAt: day2Start,
      blog: {
        title: 'Blog',
        coverImageUrl: null,
        content: 'Body',
        excerpt: 'Body',
        recipeIds: [],
      },
    });
    await createPost(db, {
      authorId: memberId,
      type: PostType.POST,
      status: PostStatus.FAILED,
      publishedAt: day1Start,
    });
    await createPost(db, {
      authorId: memberId,
      type: PostType.BLOG,
      status: PostStatus.DRAFT,
      publishedAt: null,
    });

    await createRecipe(db, { createdAt: before });
    await createRecipe(db, { createdAt: day1Start });
    await createRecipe(db, { createdAt: after });

    const reports = db.connection.model<PostReport>(PostReport.name);
    for (const [status, createdAt, reviewedAt] of [
      [PostReportStatus.PENDING, before, null],
      [PostReportStatus.PENDING, day1Start, null],
      [PostReportStatus.RESOLVED, before, day2Start],
      [PostReportStatus.DISMISSED, day1Start, day1Start],
      [PostReportStatus.RESOLVED, day2Start, after],
    ] as const) {
      const post = await createPost(db, { authorId: memberId });
      await reports.create({
        _id: randomUUID(),
        postId: post.id,
        reporterId: memberId,
        reason: PostReportReason.OTHER,
        status,
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

  it('aggregates UTC+7 Bangkok day boundaries, snapshots, and period metrics', async () => {
    const result = await service.get({ from: '2026-10-01', to: '2026-10-02' });

    expect(result.range).toEqual({
      from: '2026-10-01',
      to: '2026-10-02',
      dayCount: 2,
      timeZone: 'Asia/Bangkok',
    });
    expect(result.snapshot).toEqual({
      members: { total: 4, active: 2, suspended: 1, pendingEmail: 1 },
      pendingReports: 2,
    });
    expect(result.period).toEqual({
      newMembers: 2,
      publishedContent: { posts: 1, blogs: 1, total: 2 },
      recipesCreated: 1,
      reportsCreated: 3,
      reportDecisions: { resolved: 1, dismissed: 1, total: 2 },
    });
    expect(result.daily).toEqual([
      {
        date: '2026-10-01',
        newMembers: 1,
        publishedPosts: 1,
        publishedBlogs: 0,
        reportsCreated: 2,
        resolvedReports: 0,
        dismissedReports: 1,
      },
      {
        date: '2026-10-02',
        newMembers: 1,
        publishedPosts: 0,
        publishedBlogs: 1,
        reportsCreated: 1,
        resolvedReports: 1,
        dismissedReports: 0,
      },
    ]);
    expect(result.unavailableMetrics).toEqual([
      ...UNAVAILABLE_DASHBOARD_METRICS,
    ]);
  });

  it('zero-fills empty date ranges while preserving snapshots', async () => {
    const result = await service.get({ from: '2026-11-01', to: '2026-11-03' });
    expect(result.daily).toEqual([
      {
        date: '2026-11-01',
        newMembers: 0,
        publishedPosts: 0,
        publishedBlogs: 0,
        reportsCreated: 0,
        resolvedReports: 0,
        dismissedReports: 0,
      },
      {
        date: '2026-11-02',
        newMembers: 0,
        publishedPosts: 0,
        publishedBlogs: 0,
        reportsCreated: 0,
        resolvedReports: 0,
        dismissedReports: 0,
      },
      {
        date: '2026-11-03',
        newMembers: 0,
        publishedPosts: 0,
        publishedBlogs: 0,
        reportsCreated: 0,
        resolvedReports: 0,
        dismissedReports: 0,
      },
    ]);
    expect(result.snapshot.pendingReports).toBe(2);
    expect(result.period.newMembers).toBe(0);
  });

  it('defaults to 30 days and rejects invalid ranges', async () => {
    const defaulted = await service.get({});
    expect(defaulted.range.dayCount).toBe(30);
    expect(defaulted.daily).toHaveLength(30);

    await expect(service.get({ from: '2026-10-01' })).rejects.toBeInstanceOf(
      InvalidInputException,
    );
  });

  it('throws if a daily aggregate exceeds safe integer range', async () => {
    const usersModel = db.connection.model('User');
    vi.spyOn(usersModel, 'aggregate')
      .mockImplementationOnce(
        () => ({ exec: () => Promise.resolve([]) }) as never,
      )
      .mockImplementationOnce(
        () =>
          ({
            exec: () =>
              Promise.resolve([
                { _id: '2026-10-01', count: Number.MAX_SAFE_INTEGER + 1 },
              ]),
          }) as never,
      );

    await expect(
      service.get({ from: '2026-10-01', to: '2026-10-01' }),
    ).rejects.toThrow('Dashboard aggregate exceeds safe integer range');
  });
});
