import request from 'supertest';
import { SupportMaintenanceService } from '../../src/support/support-maintenance.service.js';
import {
  AppealOutcome,
  AppealReasonCategory,
  Notification,
  NotificationType,
  type Post,
  PostRemovalActor,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  type User,
  UserRole,
} from '../../src/mongo/models.js';
import {
  createE2eApp,
  VIOLATION_MARKER,
  type E2eApp,
} from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

interface PostBody {
  id: string;
  status: PostStatus;
  removalReason?: string | null;
  appeal?: {
    activeTicket: {
      id: string;
      code: string;
      status: SupportTicketStatus;
      outcome: AppealOutcome | null;
    } | null;
    latestTicket: {
      id: string;
      code: string;
      status: SupportTicketStatus;
      outcome: AppealOutcome | null;
    } | null;
    canAppeal: boolean;
    deadlineAt: string | null;
    blockedReason: string | null;
  } | null;
}

interface TicketBody {
  id: string;
  code: string;
  category: SupportTicketCategory;
  subject: string;
  status: SupportTicketStatus;
  referenceCode: string | null;
  messageCount: number;
  resolutionNote: string | null;
  appeal: {
    postId: string;
    triggerStatus: 'REJECTED' | 'REMOVED';
    outcome: AppealOutcome | null;
  } | null;
  messages: {
    id: string;
    senderRole: 'USER' | 'ADMIN';
    kind: string;
    isInternal: boolean;
    body: string;
  }[];
  post: { id: string; status: PostStatus } | null;
}

describe('Support tickets, content appeals & soft-delete/restore (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let other: User;
  let admin: User;
  let authorToken: string;
  let otherToken: string;
  let adminToken: string;

  const server = () => e2e.app.getHttpServer();
  const posts = () => e2e.mongo.connection.model<Post>('Post');
  const reports = () => e2e.mongo.connection.model<PostReport>('PostReport');
  const tickets = () =>
    e2e.mongo.connection.model<SupportTicket>('SupportTicket');
  const notifications = () =>
    e2e.mongo.connection.model<Notification>('Notification');

  const as = (token: string, req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    e2e = await createE2eApp('support_flows');
    author = await createUser(e2e.mongo, { username: 'support.author' });
    other = await createUser(e2e.mongo, { username: 'support.other' });
    admin = await createUser(e2e.mongo, {
      username: 'support.admin',
      role: UserRole.ADMIN,
    });
    [authorToken, otherToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(other),
      e2e.sign(admin),
    ]);
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    await Promise.all([
      posts().deleteMany({}).exec(),
      reports().deleteMany({}).exec(),
      tickets().deleteMany({}).exec(),
      e2e.mongo.connection.model('SupportMessage').deleteMany({}).exec(),
      notifications().deleteMany({}).exec(),
    ]);
  });

  const createPostViaApi = async (body: string) =>
    (
      await as(authorToken, request(server()).post('/api/v1/posts'))
        .send({ type: PostType.POST, body })
        .expect(201)
    ).body as PostBody;

  describe('general & payment support tickets', () => {
    it('supports opening PAYMENT_ISSUE tickets, multi-turn replies, internal notes, and RESOLVE/CLOSE decisions', async () => {
      // Non-appeal ticket requires a subject
      await as(authorToken, request(server()).post('/api/v1/support/tickets'))
        .send({
          category: SupportTicketCategory.PAYMENT_ISSUE,
          message: 'Thiếu tiêu đề',
        })
        .expect(400);

      const created = (
        await as(authorToken, request(server()).post('/api/v1/support/tickets'))
          .send({
            category: SupportTicketCategory.PAYMENT_ISSUE,
            subject: 'Đã chuyển khoản nhưng chưa kích hoạt gói Plus',
            referenceCode: 'VD-992817',
            message: 'Mình vừa chuyển khoản 49.000đ nhưng chưa thấy lên gói.',
          })
          .expect(201)
      ).body as TicketBody;

      expect(created.code).toMatch(/^TKT-/);
      expect(created.status).toBe(SupportTicketStatus.OPEN);
      expect(created.referenceCode).toBe('VD-992817');
      expect(created.appeal).toBeNull();

      // Admin cannot use APPROVE on a PAYMENT_ISSUE ticket
      await as(
        adminToken,
        request(server()).post(
          `/api/v1/admin/support/tickets/${created.id}/resolve`,
        ),
      )
        .send({ decision: 'APPROVE', note: 'Sai loại quyết định' })
        .expect(400);

      // Admin sends internal note (invisible to author) then public reply
      await as(
        adminToken,
        request(server()).post(
          `/api/v1/admin/support/tickets/${created.id}/messages`,
        ),
      )
        .send({ body: 'Nội bộ: kiểm tra webhook SePay', isInternal: true })
        .expect(200);

      const waiting = (
        await as(
          adminToken,
          request(server()).post(
            `/api/v1/admin/support/tickets/${created.id}/messages`,
          ),
        )
          .send({ body: 'Bạn gửi giúp thời gian chuyển khoản chính xác nhé.' })
          .expect(200)
      ).body as TicketBody;
      expect(waiting.status).toBe(SupportTicketStatus.WAITING_USER);

      const authorView = (
        await as(
          authorToken,
          request(server()).get(`/api/v1/support/tickets/${created.id}`),
        ).expect(200)
      ).body as TicketBody;
      expect(authorView.messages.some((m) => m.isInternal)).toBe(false);

      // Author replies -> OPEN, then admin resolves with RESOLVE
      const reopened = (
        await as(
          authorToken,
          request(server()).post(
            `/api/v1/support/tickets/${created.id}/messages`,
          ),
        )
          .send({ body: 'Mình chuyển lúc 14:05 hôm nay.' })
          .expect(200)
      ).body as TicketBody;
      expect(reopened.status).toBe(SupportTicketStatus.OPEN);

      const resolved = (
        await as(
          adminToken,
          request(server()).post(
            `/api/v1/admin/support/tickets/${created.id}/resolve`,
          ),
        )
          .send({
            decision: 'RESOLVE',
            note: 'Đã đối soát và kích hoạt gói Plus.',
          })
          .expect(200)
      ).body as TicketBody;
      expect(resolved.status).toBe(SupportTicketStatus.RESOLVED);

      const notice = await notifications()
        .findOne({
          recipientId: author.id,
          type: NotificationType.SUPPORT_TICKET_RESOLVED,
          ticketId: created.id,
        })
        .exec();
      expect(notice).not.toBeNull();
    });
  });

  describe('content appeals, soft-delete, locking & auto-expiration', () => {
    it('supports soft-delete (author & admin), restore, edit lock, APPROVE/REJECT, 14-day window, and 7-day auto-expire', async () => {
      // 1. Author soft-delete hides post & is not appealable; admin can restore
      const ownPost = await createPostViaApi('Món canh chua chay rất ngon');
      await as(
        authorToken,
        request(server()).delete(`/api/v1/posts/${ownPost.id}`),
      ).expect(204);
      await as(
        authorToken,
        request(server()).get(`/api/v1/posts/${ownPost.id}`),
      ).expect(404);
      expect(
        (await posts().findById(ownPost.id).exec())?.removal?.removedByRole,
      ).toBe(PostRemovalActor.AUTHOR);

      // 2. Admin soft-delete resolves pending reports, allows author to appeal, and syncs on direct restore
      const reportedPost = await createPostViaApi('Bài chia sẻ món rau củ');
      await as(
        otherToken,
        request(server()).post(`/api/v1/posts/${reportedPost.id}/report`),
      )
        .send({ reason: PostReportReason.SPAM, details: 'Trùng lặp' })
        .expect(201);
      await as(
        adminToken,
        request(server()).delete(`/api/v1/admin/posts/${reportedPost.id}`),
      )
        .send({ reason: 'Quảng cáo sai quy định' })
        .expect(204);
      expect(
        (await reports().findOne({ postId: reportedPost.id }).exec())?.status,
      ).toBe(PostReportStatus.RESOLVED);

      const removedAppeal = (
        await as(authorToken, request(server()).post('/api/v1/support/tickets'))
          .send({
            category: SupportTicketCategory.CONTENT_APPEAL,
            postId: reportedPost.id,
            reasonCategory: AppealReasonCategory.FALSE_POSITIVE,
            message: 'Bài này không phải spam, mong admin xem lại.',
          })
          .expect(201)
      ).body as TicketBody;
      expect(removedAppeal.code).toMatch(/^APL-/);

      await as(
        adminToken,
        request(server()).post(
          `/api/v1/admin/posts/${reportedPost.id}/restore`,
        ),
      )
        .send({ note: 'Đã khôi phục trực tiếp' })
        .expect(200);
      const synced = await tickets().findById(removedAppeal.id).exec();
      expect(synced?.status).toBe(SupportTicketStatus.RESOLVED);
      expect(synced?.appeal?.outcome).toBe(AppealOutcome.APPROVED);

      // 3. Rejected post appeal: locks edit/delete, rejects duplicate after REJECT, unlocks on edit
      const rejected = await createPostViaApi(
        `${VIOLATION_MARKER} Bài bị chặn`,
      );
      const appeal = (
        await as(authorToken, request(server()).post('/api/v1/support/tickets'))
          .send({
            category: SupportTicketCategory.CONTENT_APPEAL,
            postId: rejected.id,
            reasonCategory: AppealReasonCategory.CONTEXT_MISUNDERSTOOD,
            message: 'Xin xem lại ngữ cảnh.',
          })
          .expect(201)
      ).body as TicketBody;

      await as(
        authorToken,
        request(server()).patch(`/api/v1/posts/${rejected.id}`),
      )
        .send({ body: 'Cố sửa khi đang kháng cáo' })
        .expect(409);

      await as(
        adminToken,
        request(server()).post(
          `/api/v1/admin/support/tickets/${appeal.id}/resolve`,
        ),
      )
        .send({
          decision: 'REJECT',
          note: 'Nội dung vi phạm tiêu chuẩn cộng đồng.',
        })
        .expect(200);

      const dup = await as(
        authorToken,
        request(server()).post('/api/v1/support/tickets'),
      )
        .send({
          category: SupportTicketCategory.CONTENT_APPEAL,
          postId: rejected.id,
          message: 'Kháng cáo lại cùng phiên bản',
        })
        .expect(409);
      expect((dup.body as { code: string }).code).toBe('ALREADY_APPEALED');

      // 4. 7-day WAITING_USER auto-expiration
      const staleTicket = (
        await as(authorToken, request(server()).post('/api/v1/support/tickets'))
          .send({
            category: SupportTicketCategory.GENERAL,
            subject: 'Hỏi về tính năng thực đơn',
            message: 'Làm sao xuất thực đơn tuần?',
          })
          .expect(201)
      ).body as TicketBody;
      await as(
        adminToken,
        request(server()).post(
          `/api/v1/admin/support/tickets/${staleTicket.id}/messages`,
        ),
      )
        .send({ body: 'Bạn đang dùng trình duyệt nào?' })
        .expect(200);
      await tickets()
        .updateOne(
          { _id: staleTicket.id },
          {
            $set: {
              waitingUserSince: new Date(Date.now() - 8 * 86_400_000),
              waitingReminderCount: 2,
              lastReminderAt: new Date(Date.now() - 3 * 86_400_000),
            },
          },
        )
        .exec();

      const maintenance = e2e.app.get(SupportMaintenanceService);
      expect(await maintenance.followUpWaitingTickets(new Date())).toEqual({
        reminded: 0,
        expired: 1,
      });
      expect((await tickets().findById(staleTicket.id).exec())?.status).toBe(
        SupportTicketStatus.EXPIRED,
      );
    });
  });
});
