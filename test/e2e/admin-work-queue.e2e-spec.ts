import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { vi } from 'vitest';
import request from 'supertest';
import {
  AccountStatus,
  CommentReport,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  Post,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  UserRole,
  VerificationRequest,
  VerificationStatus,
  Workspace,
  User,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';
import type { AdminWorkQueueDto } from '@src/admin-dashboard/dto/work-queue.dto.js';

describe('Admin pending work and navigation badges (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let admin: User, otherAdmin: User, author: User;
  let token: string;
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const http = () => request(e2e.app.getHttpServer());
  const get = (jwt = token) =>
    http()
      .get('/api/v1/admin/dashboard/work-queue')
      .auth(jwt, { type: 'bearer' });
  const date = (n: number) =>
    new Date(`2020-01-${String(n).padStart(2, '0')}T00:00:00Z`);
  const post = (status: PostStatus, n: number, body = 'Pending post') =>
    createPost(e2e.mongo, {
      authorId: author.id,
      status,
      body,
      createdAt: date(n),
    });
  const report = (
    postId: string,
    n: number,
    status: PostReportStatus = PostReportStatus.PENDING,
  ) =>
    model<PostReport>(PostReport.name).create({
      postId,
      reporterId: randomUUID(),
      reason: PostReportReason.SPAM,
      status,
      createdAt: date(n),
    });
  let held: string, published: string, heldReport: string;
  let reportIds: string[];

  beforeAll(async () => {
    e2e = await createE2eApp('admin_work');
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    otherAdmin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    author = await createUser(e2e.mongo);
    token = await e2e.sign(admin);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('requires a currently active admin, ignoring any ADMIN claim in a member JWT', async () => {
    await http().get('/api/v1/admin/dashboard/work-queue').expect(401);
    const forged = await e2e.app
      .get(JwtService)
      .signAsync({ sub: author.id, username: author.username, role: 'ADMIN' });
    await get(forged).expect(403);
    const suspended = await createUser(e2e.mongo, {
      role: UserRole.ADMIN,
      status: AccountStatus.SUSPENDED,
    });
    await get(await e2e.sign(suspended)).expect(401);
  });

  it('returns real zeros and no preview when every queue is empty', async () => {
    const response = await get().expect(200);
    expect(response.body).toMatchObject({
      counts: {
        POST_REVIEW: 0,
        POST_REPORTS: 0,
        COMMENT_REPORTS: 0,
        VERIFICATION: 0,
        WORKSPACES: 0,
        SUPPORT: 0,
        KNOWLEDGE: 0,
      },
      badges: {
        total: 0,
        moderation: 0,
        verification: 0,
        workspaces: 0,
        support: 0,
        knowledge: 0,
      },
      support: { appeals: 0, assignedToMe: 0 },
      items: [],
      previewLimit: 10,
      refreshAfterSeconds: 30,
    });
    expect(response.headers['cache-control']).toContain('private, no-store');
    expect(response.headers.vary).toContain('Authorization');
  });

  it('aggregates all real queues globally, deduplicates reported content and excludes already handled/user-waiting states', async () => {
    const h = await post(
      PostStatus.PENDING_REVIEW,
      1,
      '  A very old held post ' + 'x'.repeat(300),
    );
    held = h.id;
    await post(PostStatus.PENDING_REVIEW, 2);
    const p = await post(PostStatus.PUBLISHED, 3, 'Reported published post');
    published = p.id;
    await post(PostStatus.REJECTED, 4);
    await post(PostStatus.PROCESSING, 5);
    await post(PostStatus.DRAFT, 6);
    const r = await report(h.id, 3);
    heldReport = r.id;
    reportIds = [];
    for (let n = 4; n <= 6; n++) reportIds.push((await report(p.id, 1)).id);
    await report(p.id, 7, PostReportStatus.DISMISSED);
    await report(p.id, 8, PostReportStatus.RESOLVED);
    await report(randomUUID(), 9); // A missing post cannot be opened in the existing post-report queue.
    const commentId = randomUUID();
    for (let n = 1; n <= 3; n++)
      await model<CommentReport>(CommentReport.name).create({
        postId: p.id,
        commentId,
        reporterId: randomUUID(),
        reason: PostReportReason.SPAM,
        status: n === 3 ? PostReportStatus.RESOLVED : PostReportStatus.PENDING,
        bodySnapshot: 'Reported comment',
        authorSnapshot: {
          id: author.id,
          username: author.username,
          fullName: author.fullName,
        },
        createdAt: date(n),
      });
    for (const [n, status] of [
      'PENDING',
      'PENDING',
      'APPROVED',
      'REJECTED',
    ].entries())
      await model<VerificationRequest>(VerificationRequest.name).create({
        userId: randomUUID(),
        statement: 'Private statement excluded',
        status: status as VerificationStatus,
        createdAt: date(n + 1),
      });
    for (const [n, status] of ['PENDING', 'APPROVED', 'REJECTED'].entries())
      await model<Workspace>(Workspace.name).create({
        username: 'restaurant.' + n,
        name: 'Restaurant ' + n,
        address: 'Private address excluded',
        location: { type: 'Point', coordinates: [106, 10] },
        statement: 'Private application excluded',
        status: status as VerificationStatus,
        createdAt: date(n + 1),
      });
    for (const [n, status] of [
      'OPEN',
      'OPEN',
      'OPEN',
      'WAITING_USER',
      'RESOLVED',
      'CLOSED',
      'WITHDRAWN',
      'EXPIRED',
    ].entries())
      await model<SupportTicket>(SupportTicket.name).create({
        code: 'SUP' + n,
        authorId: author.id,
        category:
          n === 0
            ? SupportTicketCategory.CONTENT_APPEAL
            : SupportTicketCategory.GENERAL,
        subject: 'Support case ' + n,
        status: status as SupportTicketStatus,
        lastMessageAt: date(n + 1),
        assigneeId:
          n === 0 || n === 3 ? admin.id : n === 1 ? otherAdmin.id : null,
        createdAt: date(n + 1),
      });
    for (const [n, status] of [
      'AWAITING_REVIEW',
      'AWAITING_REVIEW',
      'WAITING_UPLOAD',
      'PROCESSING',
      'INDEXING',
      'READY',
      'REJECTED',
      'FAILED',
    ].entries())
      await model<KnowledgeDocument>(KnowledgeDocument.name).create({
        title: 'Document ' + n,
        storageKey: 'private-key-' + n,
        contentType: 'application/pdf',
        status: status as KnowledgeDocumentStatus,
        createdAt: date(n + 1),
      });
    const response = await get().expect(200);
    const dto = response.body as AdminWorkQueueDto;
    expect(dto.counts).toEqual({
      POST_REVIEW: 2,
      POST_REPORTS: 2,
      COMMENT_REPORTS: 1,
      VERIFICATION: 2,
      WORKSPACES: 1,
      SUPPORT: 3,
      KNOWLEDGE: 2,
    });
    expect(dto.badges).toEqual({
      total: 12,
      moderation: 4,
      verification: 2,
      workspaces: 1,
      support: 3,
      knowledge: 2,
    });
    expect(dto.support).toEqual({ appeals: 1, assignedToMe: 1 });
    expect(dto.items).toHaveLength(10);
    expect(dto.items.filter((row) => row.id === held)).toHaveLength(1);
    expect(dto.items.find((row) => row.id === held)?.kind).toBe('POST_REVIEW');
    expect(dto.items.find((row) => row.id === published)?.sourceCount).toBe(3);
    expect(
      dto.items.find((row) => row.kind === 'COMMENT_REPORTS')?.sourceCount,
    ).toBe(2);
    expect(dto.items.every((row) => row.title.length <= 120)).toBe(true);
    const times = dto.items.map((row) => Date.parse(String(row.createdAt)));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const json = JSON.stringify(dto);
    for (const value of [
      'private-key-',
      'Private statement excluded',
      'Private address excluded',
      'Private application excluded',
      'storageKey',
      'reporterId',
      'assigneeId',
      'passwordHash',
    ])
      expect(json).not.toContain(value);
  });

  it('personalizes assigned open support work without changing global queue counts', async () => {
    const mine = (await get().expect(200)).body as AdminWorkQueueDto;
    const other = (await get(await e2e.sign(otherAdmin)).expect(200))
      .body as AdminWorkQueueDto;
    expect(other.badges).toEqual(mine.badges);
    expect(other.support.assignedToMe).toBe(1);
    await model<SupportTicket>(SupportTicket.name).updateOne(
      { code: 'SUP1' },
      { $set: { assigneeId: null } },
    );
    const changed = (await get(await e2e.sign(otherAdmin)).expect(200))
      .body as AdminWorkQueueDto;
    expect(changed.support.assignedToMe).toBe(0);
    expect(changed.badges.support).toBe(3);
  });

  it('refreshes after review; clearing a report on a held post does not remove the remaining moderation job', async () => {
    // Existing review DTOs need a reporter account; bind the fixture report to one.
    await model<PostReport>(PostReport.name).updateOne(
      { _id: heldReport },
      { $set: { reporterId: author.id } },
    );
    await http()
      .post('/api/v1/admin/reports/' + heldReport + '/review')
      .auth(token, { type: 'bearer' })
      .send({ status: 'DISMISSED' })
      .expect(200);
    const after = (await get().expect(200)).body as AdminWorkQueueDto;
    expect(after.counts.POST_REPORTS).toBe(1);
    expect(after.badges.moderation).toBe(4);
    await model<Post>(Post.name).updateOne(
      { _id: held },
      { $set: { status: PostStatus.PUBLISHED } },
    );
    const publishedDto = (await get().expect(200)).body as AdminWorkQueueDto;
    expect(publishedDto.badges.total).toBe(11);
    expect(publishedDto.badges.moderation).toBe(3);
    await model<PostReport>(PostReport.name).updateMany(
      { _id: { $in: reportIds } },
      { $set: { status: 'RESOLVED' } },
    );
    const cleared = (await get().expect(200)).body as AdminWorkQueueDto;
    expect(cleared.counts.POST_REPORTS).toBe(0);
    expect(cleared.badges.total).toBe(10);
    expect(cleared.badges.moderation).toBe(2);
  });

  it('fails visibly instead of fabricating zero counters when a database query fails', async () => {
    vi.spyOn(model<Post>(Post.name), 'aggregate').mockImplementationOnce(() => {
      throw new Error('Simulated work queue read failure');
    });
    const response = await get().expect(500);
    expect(response.body).not.toHaveProperty('counts');
  });

  it('does not create system-log entries for reading the overview', async () => {
    const before = await e2e.connection.model('SystemLog').countDocuments();
    await get().expect(200);
    await get().expect(200);
    expect(await e2e.connection.model('SystemLog').countDocuments()).toBe(
      before,
    );
  });
});
