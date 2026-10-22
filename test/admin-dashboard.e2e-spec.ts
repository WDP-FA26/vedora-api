import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/app.setup';

describe('Admin dashboard (HTTP)', () => {
  const adminId = 'c9ee4d58-ce10-4572-bd39-952a310ace87';
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;
  let jwt: JwtService;
  const route = '/api/v1/admin/dashboard';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
    token = await jwt.signAsync({ sub: adminId, username: 'admin' });
  });
  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: adminId,
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValue([] as never);
    prisma.postReport.count.mockResolvedValue(0);
    prisma.recipe.count.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((operation: unknown) =>
      (operation as (tx: PrismaService) => Promise<never>)(prisma),
    );
  });
  afterAll(async () => app?.close());

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get(route).expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects members even when a signed token claims ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: adminId,
      username: 'member',
      role: 'USER',
      status: 'ACTIVE',
    } as never);
    const claimed = await jwt.signAsync({
      sub: adminId,
      username: 'member',
      role: 'ADMIN',
    });
    await request(app.getHttpServer())
      .get(route)
      .auth(claimed, { type: 'bearer' })
      .expect(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects suspended administrators', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: adminId,
      username: 'admin',
      role: 'ADMIN',
      status: 'SUSPENDED',
    } as never);
    await request(app.getHttpServer())
      .get(route)
      .auth(token, { type: 'bearer' })
      .expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns a private default dashboard with explicit unavailable metrics', async () => {
    const response = await request(app.getHttpServer())
      .get(route)
      .auth(token, { type: 'bearer' })
      .expect(200);
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
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'RepeatableRead',
    });
  });

  it('fills missing days with actual zero counts and serializes bigint aggregates', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        date: '2026-10-02',
        newMembers: 2n,
        publishedPosts: 1n,
        publishedBlogs: 3n,
        reportsCreated: 4n,
        resolvedReports: 1n,
        dismissedReports: 2n,
      },
    ]);
    const response = await request(app.getHttpServer())
      .get(`${route}?from=2026-10-01&to=2026-10-03`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({
      period: {
        newMembers: 2,
        publishedContent: { posts: 1, blogs: 3, total: 4 },
        reportsCreated: 4,
        reportDecisions: { resolved: 1, dismissed: 2, total: 3 },
      },
      daily: [
        { date: '2026-10-01', newMembers: 0 },
        { date: '2026-10-02', newMembers: 2 },
        { date: '2026-10-03', newMembers: 0 },
      ],
    });
    expect(prisma.recipe.count.mock.calls[0][0]?.where?.createdAt).toEqual({
      gte: new Date('2026-09-30T17:00:00Z'),
      lt: new Date('2026-10-03T17:00:00Z'),
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
  ])(
    'rejects unsupported/invalid query %s before aggregation',
    async (query) => {
      await request(app.getHttpServer())
        .get(`${route}?${query}`)
        .auth(token, { type: 'bearer' })
        .expect(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
});
