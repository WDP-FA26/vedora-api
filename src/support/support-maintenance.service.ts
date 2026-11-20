import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { ClientSession, Model } from 'mongoose';
import { runtimeConfig } from '../config/runtime-config.js';
import {
  AccountStatus,
  NotificationType,
  SupportMessage,
  SupportMessageKind,
  SupportSenderRole,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  User,
} from '../mongo/models.js';
import { MailService, type SupportFollowUpKind } from '../mail/mail.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import { MongoService } from '../mongo/mongo.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  autoCloseAtOf,
  nextWaitingStep,
  waitingReminderTimings,
  type WaitingStep,
} from './support-policy.js';

const MS_PER_HOUR = 3_600_000;

export interface WaitingSweepResult {
  reminded: number;
  expired: number;
}

interface StepOutcome {
  authorId: string;
  postId: string | null;
  ticketCode: string;
  ticketSubject: string;
  note: string;
}

const EMAIL_KIND_BY_STEP: Record<WaitingStep, SupportFollowUpKind> = {
  FIRST_REMINDER: 'REMINDER',
  FINAL_REMINDER: 'FINAL_REMINDER',
  EXPIRE: 'EXPIRED',
};

function formatDeadline(date: Date): string {
  return date.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function firstReminderText(): string {
  return 'Ban quản trị Vedora vẫn đang chờ thông tin từ bạn để tiếp tục xử lý hồ sơ này. Bạn chỉ cần trả lời ngay trong hồ sơ.';
}

function finalReminderText(closeAt: Date): string {
  return `Hồ sơ sẽ tự động đóng lúc ${formatDeadline(closeAt)} nếu chưa nhận được phản hồi của bạn.`;
}

function expiredText(ticket: SupportTicket): string {
  const days = runtimeConfig.APPEAL_WAITING_USER_EXPIRE_DAYS;
  const base = `Hồ sơ đã tự động đóng do không nhận được phản hồi sau ${days} ngày.`;
  if (ticket.category === SupportTicketCategory.CONTENT_APPEAL) return base;
  return `${base} Bạn có thể trả lời trong ${runtimeConfig.SUPPORT_REOPEN_WINDOW_DAYS} ngày để mở lại hồ sơ.`;
}

/**
 * Follows up on tickets waiting for their author, the way Zendesk's
 * "bump, bump, solve" does: a reminder, a final warning, then expiry. Each
 * step is a public message plus a notification, and only a ticket that got
 * both reminders can expire. Any reply resets the count (see the services).
 * Each step is also emailed through Resend after the transaction commits.
 */
@Injectable()
export class SupportMaintenanceService {
  private readonly logger = new Logger(SupportMaintenanceService.name);

  constructor(
    @InjectModel(SupportTicket.name)
    private readonly tickets: Model<SupportTicket>,
    @InjectModel(SupportMessage.name)
    private readonly messages: Model<SupportMessage>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly mongo: MongoService,
    private readonly config: ConfigService,
  ) {}

  @Cron(runtimeConfig.APPEAL_EXPIRATION_CRON)
  async runScheduledFollowUps(): Promise<void> {
    const result = await this.followUpWaitingTickets();
    if (result.reminded > 0 || result.expired > 0) {
      this.logger.log(
        `Support follow-ups: ${result.reminded} reminded, ${result.expired} expired`,
      );
    }
  }

  async followUpWaitingTickets(
    now: Date = new Date(),
  ): Promise<WaitingSweepResult> {
    const timings = waitingReminderTimings();
    const earliest = new Date(
      now.getTime() - timings.firstReminderHours * MS_PER_HOUR,
    );
    const due = await this.tickets
      .find({
        status: SupportTicketStatus.WAITING_USER,
        waitingUserSince: { $lte: earliest },
      })
      .sort({ waitingUserSince: 1, _id: 1 })
      .limit(runtimeConfig.APPEAL_EXPIRATION_BATCH_SIZE)
      .exec();

    const result: WaitingSweepResult = { reminded: 0, expired: 0 };
    for (const ticket of due) {
      const step = nextWaitingStep(ticket, now, timings);
      if (!step) continue;
      const outcome = await this.applyStep(ticket.id, step, now);
      if (!outcome) continue;

      if (step === 'EXPIRE') result.expired += 1;
      else result.reminded += 1;
      await this.notifications.notify({
        recipientId: outcome.authorId,
        type:
          step === 'EXPIRE'
            ? NotificationType.SUPPORT_TICKET_EXPIRED
            : NotificationType.SUPPORT_TICKET_REMINDER,
        postId: outcome.postId ?? undefined,
        ticketId: ticket.id,
        note: outcome.note,
      });
      await this.emailAuthor(ticket.id, step, outcome);
    }
    return result;
  }

  /**
   * Emails the step to the author when their address is verified and the
   * account is active. Email is a best-effort copy of the in-app message and
   * notification, so a failed send is logged and the sweep moves on.
   */
  private async emailAuthor(
    ticketId: string,
    step: WaitingStep,
    outcome: StepOutcome,
  ): Promise<void> {
    const author = await this.users
      .findOne({ _id: outcome.authorId })
      .select({ email: 1, status: 1, emailVerifiedAt: 1 })
      .exec();
    if (!author || author.status !== AccountStatus.ACTIVE) return;
    if (!author.emailVerifiedAt) return;

    const frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    try {
      await this.mail.sendSupportFollowUp(author.email, {
        kind: EMAIL_KIND_BY_STEP[step],
        ticketCode: outcome.ticketCode,
        ticketSubject: outcome.ticketSubject,
        message: outcome.note,
        ticketUrl: new URL(`/home/support/${ticketId}`, frontendUrl).toString(),
      });
    } catch (error) {
      this.logger.warn(
        `Could not email follow-up for ticket ${ticketId}: ${String(error)}`,
      );
    }
  }

  /**
   * Re-reads the ticket under its lock and applies the step only if it is
   * still due, so a reply that commits first wins and nothing is sent twice.
   */
  private async applyStep(
    ticketId: string,
    step: WaitingStep,
    now: Date,
  ): Promise<StepOutcome | null> {
    let outcome: StepOutcome | null = null;
    await this.mongo.withTransaction(async (session) => {
      outcome = null;
      await lockDocument(this.mongo, session, 'ticket', ticketId);
      const ticket = await this.tickets
        .findOne({ _id: ticketId })
        .session(session)
        .exec();
      if (!ticket || nextWaitingStep(ticket, now) !== step) return;

      const note =
        step === 'EXPIRE'
          ? await this.expire(ticket, now, session)
          : await this.remind(ticket, step, now, session);
      outcome = {
        authorId: ticket.authorId,
        postId: ticket.appeal?.postId ?? null,
        ticketCode: ticket.code,
        ticketSubject: ticket.subject,
        note,
      };
    });
    return outcome;
  }

  private async remind(
    ticket: SupportTicket,
    step: 'FIRST_REMINDER' | 'FINAL_REMINDER',
    now: Date,
    session: ClientSession,
  ): Promise<string> {
    const reminded = {
      status: ticket.status,
      waitingUserSince: ticket.waitingUserSince,
      waitingReminderCount: ticket.waitingReminderCount + 1,
      lastReminderAt: now,
    };
    const closeAt = autoCloseAtOf(reminded) ?? now;
    const body =
      step === 'FIRST_REMINDER'
        ? firstReminderText()
        : finalReminderText(closeAt);

    await this.messages.create(
      [
        {
          ticketId: ticket.id,
          senderId: null,
          senderRole: SupportSenderRole.ADMIN,
          kind: SupportMessageKind.REMINDER,
          isInternal: false,
          body,
        },
      ],
      { session },
    );
    // Reminders are not replies: lastMessageAt stays on the real conversation.
    await this.tickets
      .updateOne(
        { _id: ticket.id },
        {
          $set: { lastReminderAt: now },
          $inc: { waitingReminderCount: 1, messageCount: 1 },
        },
        { session },
      )
      .exec();
    return body;
  }

  private async expire(
    ticket: SupportTicket,
    now: Date,
    session: ClientSession,
  ): Promise<string> {
    const note = expiredText(ticket);
    await this.tickets
      .updateOne(
        { _id: ticket.id },
        {
          $set: {
            status: SupportTicketStatus.EXPIRED,
            waitingUserSince: null,
            waitingReminderCount: 0,
            lastReminderAt: null,
            resolvedAt: now,
            resolutionNote: note,
            lastMessageAt: now,
            lastMessageByRole: SupportSenderRole.ADMIN,
          },
          $inc: { messageCount: 1 },
        },
        { session },
      )
      .exec();
    await this.messages.create(
      [
        {
          ticketId: ticket.id,
          senderId: null,
          senderRole: SupportSenderRole.ADMIN,
          kind: SupportMessageKind.EXPIRED,
          isInternal: false,
          body: note,
        },
      ],
      { session },
    );
    return note;
  }
}
