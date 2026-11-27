import request from 'supertest';
import {
  Notification,
  NotificationType,
  SupportAttachment,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  type User,
  UserRole,
} from '@src/mongo/models.js';
import {
  MailService,
  type SupportFollowUpEmail,
} from '@src/mail/mail.service.js';
import { StorageService } from '@src/storage/storage.service.js';
import { SupportMaintenanceService } from '@src/support/support-maintenance.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

interface TicketBody {
  id: string;
  status: SupportTicketStatus;
  messageCount: number;
  resolvedAt: string | null;
  resolutionNote: string | null;
  reopenableUntil?: string | null;
  assignee?: { id: string } | null;
  messages: {
    id: string;
    kind: string;
    isInternal: boolean;
    body: string;
    attachments: { id: string; url: string; contentType: string }[];
  }[];
}

interface ErrorBody {
  code: string;
}

interface AdminPageBody {
  items: { id: string; assignee: { id: string } | null }[];
}

const missingKeys = new Set<string>();
const fakeStorage = {
  isConfigured: () => true,
  presignUpload: (_target: string, key: string) =>
    Promise.resolve({
      url: `https://storage.test/${key}`,
      method: 'PUT' as const,
      headers: { 'content-type': 'image/png' },
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  exists: (_target: string, key: string) =>
    Promise.resolve(!missingKeys.has(key)),
  presignDownload: (_target: string, key: string) =>
    Promise.resolve(`https://storage.test/${key}?signed=1`),
  delete: () => Promise.resolve(),
};

const sentFollowUps: { to: string; followUp: SupportFollowUpEmail }[] = [];
let failMail = false;
const fakeMail = {
  sendSupportFollowUp: (to: string, followUp: SupportFollowUpEmail) => {
    if (failMail) return Promise.reject(new Error('Resend is down'));
    sentFollowUps.push({ to, followUp });
    return Promise.resolve();
  },
};

describe('Support handling: claims, reopen, attachments & internal notes (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let adminA: User;
  let adminB: User;
  let authorToken: string;
  let strangerToken: string;
  let adminAToken: string;
  let adminBToken: string;

  const server = () => e2e.app.getHttpServer();
  const tickets = () =>
    e2e.mongo.connection.model<SupportTicket>('SupportTicket');
  const attachments = () =>
    e2e.mongo.connection.model<SupportAttachment>('SupportAttachment');
  const as = (token: string, req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    e2e = await createE2eApp('support_handling', (builder) =>
      builder
        .overrideProvider(StorageService)
        .useValue(fakeStorage)
        .overrideProvider(MailService)
        .useValue(fakeMail),
    );
    author = await createUser(e2e.mongo, { username: 'handling.author' });
    stranger = await createUser(e2e.mongo, { username: 'handling.stranger' });
    adminA = await createUser(e2e.mongo, {
      username: 'handling.admin.a',
      role: UserRole.ADMIN,
    });
    adminB = await createUser(e2e.mongo, {
      username: 'handling.admin.b',
      role: UserRole.ADMIN,
    });
    [authorToken, strangerToken, adminAToken, adminBToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(stranger),
      e2e.sign(adminA),
      e2e.sign(adminB),
    ]);
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    missingKeys.clear();
    await Promise.all([
      tickets().deleteMany({}).exec(),
      e2e.mongo.connection.model('SupportMessage').deleteMany({}).exec(),
      attachments().deleteMany({}).exec(),
    ]);
  });

  const openTicket = async (subject = 'Chưa kích hoạt gói Plus') =>
    (
      await as(authorToken, request(server()).post('/api/v1/support/tickets'))
        .send({
          category: SupportTicketCategory.PAYMENT_ISSUE,
          subject,
          message: 'Mình đã chuyển khoản nhưng chưa lên gói.',
        })
        .expect(201)
    ).body as TicketBody;

  const adminPost = (token: string, id: string, action: string) =>
    as(
      token,
      request(server()).post(`/api/v1/admin/support/tickets/${id}/${action}`),
    );

  const authorReply = (id: string) =>
    as(
      authorToken,
      request(server()).post(`/api/v1/support/tickets/${id}/messages`),
    );

  const uploadImage = async (token: string) =>
    (
      await as(token, request(server()).post('/api/v1/support/attachments'))
        .send({ contentType: 'image/png', sizeBytes: 2048 })
        .expect(201)
    ).body as { id: string };

  describe('claiming', () => {
    it('lets one admin own a ticket while others can only add internal notes', async () => {
      const ticket = await openTicket();

      const claimed = (
        await adminPost(adminAToken, ticket.id, 'claim').send({}).expect(200)
      ).body as TicketBody;
      expect(claimed.assignee?.id).toBe(adminA.id);

      const blockedReply = await adminPost(adminBToken, ticket.id, 'messages')
        .send({ body: 'Mình kiểm tra giúp bạn nhé.' })
        .expect(409);
      expect((blockedReply.body as ErrorBody).code).toBe(
        'TICKET_CLAIMED_BY_OTHER',
      );
      await adminPost(adminBToken, ticket.id, 'resolve')
        .send({ decision: 'RESOLVE' })
        .expect(409);
      await adminPost(adminBToken, ticket.id, 'claim').send({}).expect(409);
      await adminPost(adminBToken, ticket.id, 'release').expect(409);

      await adminPost(adminBToken, ticket.id, 'messages')
        .send({ body: 'Nội bộ: giao dịch đã vào tài khoản.', isInternal: true })
        .expect(200);

      const mine = (
        await as(
          adminAToken,
          request(server()).get('/api/v1/admin/support/tickets?assignee=me'),
        ).expect(200)
      ).body as AdminPageBody;
      expect(mine.items.map((item) => item.id)).toEqual([ticket.id]);
      const unassigned = (
        await as(
          adminAToken,
          request(server()).get(
            '/api/v1/admin/support/tickets?assignee=unassigned',
          ),
        ).expect(200)
      ).body as AdminPageBody;
      expect(unassigned.items).toHaveLength(0);

      const takenOver = (
        await adminPost(adminBToken, ticket.id, 'claim')
          .send({ force: true })
          .expect(200)
      ).body as TicketBody;
      expect(takenOver.assignee?.id).toBe(adminB.id);

      const released = (
        await adminPost(adminBToken, ticket.id, 'release').expect(200)
      ).body as TicketBody;
      expect(released.assignee).toBeNull();
      await adminPost(adminBToken, ticket.id, 'release').expect(409);
    });

    it('claims an unclaimed ticket for the admin who replies first', async () => {
      const ticket = await openTicket();
      const replied = (
        await adminPost(adminAToken, ticket.id, 'messages')
          .send({ body: 'Bạn gửi giúp mã giao dịch nhé.' })
          .expect(200)
      ).body as TicketBody;
      expect(replied.assignee?.id).toBe(adminA.id);
      expect(replied.status).toBe(SupportTicketStatus.WAITING_USER);
    });
  });

  describe('reopening', () => {
    it('reopens a finished ticket when the author replies, keeping the assignee', async () => {
      const ticket = await openTicket();
      await adminPost(adminAToken, ticket.id, 'resolve')
        .send({ decision: 'RESOLVE', note: 'Đã kích hoạt gói.' })
        .expect(200);

      const closedView = (
        await as(
          authorToken,
          request(server()).get(`/api/v1/support/tickets/${ticket.id}`),
        ).expect(200)
      ).body as TicketBody;
      expect(closedView.reopenableUntil).not.toBeNull();

      const reopened = (
        await authorReply(ticket.id)
          .send({ body: 'Gói lại bị mất sau một ngày.' })
          .expect(200)
      ).body as TicketBody;
      expect(reopened.status).toBe(SupportTicketStatus.OPEN);
      expect(reopened.resolvedAt).toBeNull();
      expect(reopened.resolutionNote).toBeNull();
      expect(reopened.reopenableUntil).toBeNull();
      const kinds = reopened.messages.map((message) => message.kind);
      expect(kinds.slice(-2)).toEqual(['REOPENED', 'MESSAGE']);

      const stored = await tickets().findOne({ _id: ticket.id }).exec();
      expect(stored?.assigneeId).toBe(adminA.id);
    });

    it('refuses to reopen after the window or past the active-ticket limit', async () => {
      const old = await openTicket('Hồ sơ cũ');
      await adminPost(adminAToken, old.id, 'resolve')
        .send({ decision: 'RESOLVE' })
        .expect(200);
      await tickets()
        .updateOne(
          { _id: old.id },
          { $set: { resolvedAt: new Date(Date.now() - 31 * 86_400_000) } },
        )
        .exec();
      const expired = await authorReply(old.id)
        .send({ body: 'Còn mở lại được không?' })
        .expect(409);
      expect((expired.body as ErrorBody).code).toBe(
        'TICKET_REOPEN_WINDOW_EXPIRED',
      );

      const recent = await openTicket('Hồ sơ vừa đóng');
      await adminPost(adminAToken, recent.id, 'resolve')
        .send({ decision: 'RESOLVE' })
        .expect(200);
      for (let index = 0; index < 5; index += 1) {
        await openTicket(`Hồ sơ đang mở ${index}`);
      }
      const limited = await authorReply(recent.id)
        .send({ body: 'Mở lại giúp mình.' })
        .expect(409);
      expect((limited.body as ErrorBody).code).toBe('TICKET_LIMIT_REACHED');
    });
  });

  describe('internal notes', () => {
    it('accepts internal notes on a closed ticket but not public replies', async () => {
      const ticket = await openTicket();
      await adminPost(adminAToken, ticket.id, 'resolve')
        .send({ decision: 'CLOSE', note: 'Trùng hồ sơ khác.' })
        .expect(200);

      await adminPost(adminBToken, ticket.id, 'messages')
        .send({
          body: 'Nội bộ: đã gộp vào hồ sơ TKT-ABCDEF.',
          isInternal: true,
        })
        .expect(200);
      const publicReply = await adminPost(adminAToken, ticket.id, 'messages')
        .send({ body: 'Xin chào' })
        .expect(409);
      expect((publicReply.body as ErrorBody).code).toBe(
        'TICKET_ALREADY_CLOSED',
      );
    });
  });

  describe('attachments', () => {
    it('sends image-only messages and keeps uploads private to their owner', async () => {
      const ticket = await openTicket();

      const empty = await authorReply(ticket.id).send({}).expect(400);
      expect((empty.body as ErrorBody).code).toBe('TICKET_MESSAGE_EMPTY');

      const image = await uploadImage(authorToken);
      const strangersImage = await uploadImage(strangerToken);

      const stolen = await authorReply(ticket.id)
        .send({ attachmentIds: [strangersImage.id] })
        .expect(400);
      expect((stolen.body as ErrorBody).code).toBe('UNKNOWN_ATTACHMENT');

      const sent = (
        await authorReply(ticket.id)
          .send({ attachmentIds: [image.id] })
          .expect(200)
      ).body as TicketBody;
      const last = sent.messages[sent.messages.length - 1];
      expect(last?.body).toBe('');
      expect(last?.attachments.map((item) => item.id)).toEqual([image.id]);
      expect(last?.attachments[0]?.url).toContain('signed=1');

      await authorReply(ticket.id)
        .send({ body: 'Gửi lại ảnh', attachmentIds: [image.id] })
        .expect(400);

      const pending = await uploadImage(authorToken);
      const row = await attachments().findOne({ _id: pending.id }).exec();
      missingKeys.add(row?.storageKey ?? '');
      const notUploaded = await authorReply(ticket.id)
        .send({ attachmentIds: [pending.id] })
        .expect(409);
      expect((notUploaded.body as ErrorBody).code).toBe(
        'ATTACHMENT_NOT_UPLOADED',
      );
    });

    it('hides images on internal notes from the author', async () => {
      const ticket = await openTicket();
      const image = await uploadImage(adminAToken);
      await adminPost(adminAToken, ticket.id, 'messages')
        .send({ isInternal: true, attachmentIds: [image.id] })
        .expect(200);

      const adminView = (
        await as(
          adminAToken,
          request(server()).get(`/api/v1/admin/support/tickets/${ticket.id}`),
        ).expect(200)
      ).body as TicketBody;
      expect(
        adminView.messages.some((message) => message.attachments.length > 0),
      ).toBe(true);

      const authorView = (
        await as(
          authorToken,
          request(server()).get(`/api/v1/support/tickets/${ticket.id}`),
        ).expect(200)
      ).body as TicketBody;
      expect(
        authorView.messages.every(
          (message) => message.attachments.length === 0,
        ),
      ).toBe(true);
    });
  });

  describe('waiting-on-author follow-ups', () => {
    const HOUR = 3_600_000;
    const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
    const notifications = () =>
      e2e.mongo.connection.model<Notification>('Notification');
    const sweep = () =>
      e2e.app.get(SupportMaintenanceService).followUpWaitingTickets(new Date());
    const setWaiting = (id: string, fields: Partial<SupportTicket>) =>
      tickets().updateOne({ _id: id }, { $set: fields }).exec();

    const waitingTicket = async () => {
      const ticket = await openTicket();
      await adminPost(adminAToken, ticket.id, 'messages')
        .send({ body: 'Bạn gửi giúp ảnh biên lai nhé.' })
        .expect(200);
      return ticket;
    };

    it('reminds, warns, then expires only after both reminders', async () => {
      await notifications().deleteMany({}).exec();
      const ticket = await waitingTicket();

      expect(await sweep()).toEqual({ reminded: 0, expired: 0 });

      await setWaiting(ticket.id, { waitingUserSince: ago(49) });
      expect(await sweep()).toEqual({ reminded: 1, expired: 0 });
      expect(await sweep()).toEqual({ reminded: 0, expired: 0 });

      await setWaiting(ticket.id, { waitingUserSince: ago(400) });
      expect(await sweep()).toEqual({ reminded: 1, expired: 0 });

      const warned = await tickets().findOne({ _id: ticket.id }).exec();
      expect(warned?.status).toBe(SupportTicketStatus.WAITING_USER);
      expect(warned?.waitingReminderCount).toBe(2);
      expect(await sweep()).toEqual({ reminded: 0, expired: 0 });

      await setWaiting(ticket.id, { lastReminderAt: ago(49) });
      expect(await sweep()).toEqual({ reminded: 0, expired: 1 });

      const view = (
        await as(
          authorToken,
          request(server()).get(`/api/v1/support/tickets/${ticket.id}`),
        ).expect(200)
      ).body as TicketBody;
      expect(view.status).toBe(SupportTicketStatus.EXPIRED);
      expect(view.messages.map((message) => message.kind).slice(-3)).toEqual([
        'REMINDER',
        'REMINDER',
        'EXPIRED',
      ]);
      const reminders = await notifications()
        .countDocuments({
          recipientId: author.id,
          ticketId: ticket.id,
          type: NotificationType.SUPPORT_TICKET_REMINDER,
        })
        .exec();
      expect(reminders).toBe(2);

      const emailed = sentFollowUps.filter(
        (sent) => sent.followUp.ticketCode === ticket.code,
      );
      expect(emailed.map((sent) => sent.followUp.kind)).toEqual([
        'REMINDER',
        'FINAL_REMINDER',
        'EXPIRED',
      ]);
      expect(emailed.every((sent) => sent.to === author.email)).toBe(true);
      expect(emailed[0]?.followUp.ticketUrl).toMatch(
        new RegExp(`/home/support/${ticket.id}$`),
      );
    });

    it('still reminds when the email cannot be sent', async () => {
      const ticket = await waitingTicket();
      await setWaiting(ticket.id, { waitingUserSince: ago(49) });
      failMail = true;
      try {
        expect(await sweep()).toEqual({ reminded: 1, expired: 0 });
      } finally {
        failMail = false;
      }
      const reminded = await tickets().findOne({ _id: ticket.id }).exec();
      expect(reminded?.waitingReminderCount).toBe(1);
    });

    it('starts the count again when the author replies', async () => {
      const ticket = await waitingTicket();
      await setWaiting(ticket.id, { waitingUserSince: ago(49) });
      expect(await sweep()).toEqual({ reminded: 1, expired: 0 });

      await authorReply(ticket.id).send({ body: 'Đây là ảnh ạ.' }).expect(200);
      await adminPost(adminAToken, ticket.id, 'messages')
        .send({ body: 'Bạn gửi thêm mã giao dịch nhé.' })
        .expect(200);

      const fresh = await tickets().findOne({ _id: ticket.id }).exec();
      expect(fresh?.waitingReminderCount).toBe(0);
      expect(fresh?.lastReminderAt).toBeNull();
      expect(await sweep()).toEqual({ reminded: 0, expired: 0 });
    });
  });
});
