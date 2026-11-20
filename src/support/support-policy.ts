import { randomBytes } from 'node:crypto';
import { runtimeConfig } from '../config/runtime-config.js';
import {
  AppealOutcome,
  PostRemovalActor,
  PostStatus,
  PostType,
  SupportTicketCategory,
  SupportTicketStatus,
  type AppealPostSnapshot,
  type AppealTriggerStatus,
  type Post,
  type SupportTicket,
} from '../mongo/models.js';

const MS_PER_DAY = 86_400_000;
const EXCERPT_MAX_LENGTH = 140;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

export const ACTIVE_TICKET_STATUSES: readonly SupportTicketStatus[] = [
  SupportTicketStatus.OPEN,
  SupportTicketStatus.WAITING_USER,
];

export const APPEAL_BLOCKED_REASONS = [
  'NOT_APPEALABLE',
  'APPEAL_IN_PROGRESS',
  'APPEAL_WINDOW_EXPIRED',
  'ALREADY_APPEALED',
  'WITHDRAWAL_LIMIT_REACHED',
] as const;

export type AppealBlockedReason = (typeof APPEAL_BLOCKED_REASONS)[number];

export interface AppealEligibilityOptions {
  windowDays?: number;
  maxWithdrawalsPerIncident?: number;
}

export interface PostAppealTicketRef {
  id: string;
  code: string;
  status: SupportTicketStatus;
  outcome: AppealOutcome | null;
  resolvedAt: Date | null;
}

export interface AppealEligibility {
  triggerStatus: AppealTriggerStatus | null;
  incidentKey: string | null;
  blockedAt: Date | null;
  deadlineAt: Date | null;
  activeTicket: PostAppealTicketRef | null;
  latestTicket: PostAppealTicketRef | null;
  canAppeal: boolean;
  blockedReason: AppealBlockedReason | null;
}

export function isTicketActive(status: SupportTicketStatus): boolean {
  return (
    status === SupportTicketStatus.OPEN ||
    status === SupportTicketStatus.WAITING_USER
  );
}

/**
 * Every REJECTED post and every admin-REMOVED post can be appealed.
 * Author self-deleted posts are never appealable.
 */
export function appealTriggerStatusOf(post: Post): AppealTriggerStatus | null {
  if (post.status === PostStatus.REJECTED) return 'REJECTED';
  if (
    post.status === PostStatus.REMOVED &&
    post.removal?.removedByRole === PostRemovalActor.ADMIN
  ) {
    return 'REMOVED';
  }
  return null;
}

/**
 * Deterministic timestamp of the rejection or admin removal. Rejecting an
 * appeal never mutates `post.moderation.reviewedAt`, so this value stays stable
 * for the entire incident.
 */
export function blockedAtOf(post: Post): Date | null {
  const trigger = appealTriggerStatusOf(post);
  if (trigger === 'REMOVED') {
    return post.removal?.removedAt ?? post.updatedAt ?? post.createdAt;
  }
  if (trigger === 'REJECTED') {
    const mod = post.moderation;
    if (!mod) return post.updatedAt ?? post.createdAt;
    if (mod.reviewedById && mod.reviewedAt) return mod.reviewedAt;
    if (mod.route?.appliedBy && mod.route.decidedAt) return mod.route.decidedAt;
    return mod.checkedAt;
  }
  return null;
}

export function incidentKeyOf(post: Post): string | null {
  const trigger = appealTriggerStatusOf(post);
  const blockedAt = blockedAtOf(post);
  if (!trigger || !blockedAt) return null;
  return `${trigger}:${blockedAt.toISOString()}`;
}

export function appealDeadlineOf(
  blockedAt: Date,
  windowDays = runtimeConfig.APPEAL_WINDOW_DAYS,
): Date {
  return new Date(blockedAt.getTime() + windowDays * MS_PER_DAY);
}

function toRef(ticket: SupportTicket): PostAppealTicketRef {
  return {
    id: ticket.id,
    code: ticket.code,
    status: ticket.status,
    outcome: ticket.appeal?.outcome ?? null,
    resolvedAt: ticket.resolvedAt,
  };
}

export function evaluateAppealEligibility(
  post: Post,
  tickets: readonly SupportTicket[],
  now: Date = new Date(),
  options: AppealEligibilityOptions = {},
): AppealEligibility {
  const windowDays = options.windowDays ?? runtimeConfig.APPEAL_WINDOW_DAYS;
  const maxWithdrawals =
    options.maxWithdrawalsPerIncident ??
    runtimeConfig.APPEAL_MAX_WITHDRAWALS_PER_INCIDENT;

  const appealTickets = tickets
    .filter(
      (ticket) => ticket.category === SupportTicketCategory.CONTENT_APPEAL,
    )
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );

  const active =
    appealTickets.find((ticket) => isTicketActive(ticket.status)) ?? null;
  const latest = appealTickets[0] ?? null;

  const triggerStatus = appealTriggerStatusOf(post);
  const blockedAt = blockedAtOf(post);
  const incidentKey =
    triggerStatus && blockedAt
      ? `${triggerStatus}:${blockedAt.toISOString()}`
      : null;
  const deadlineAt = blockedAt ? appealDeadlineOf(blockedAt, windowDays) : null;

  if (!triggerStatus || !blockedAt || !incidentKey || !deadlineAt) {
    return {
      triggerStatus: null,
      incidentKey: null,
      blockedAt: null,
      deadlineAt: null,
      activeTicket: active ? toRef(active) : null,
      latestTicket: latest ? toRef(latest) : null,
      canAppeal: false,
      blockedReason: 'NOT_APPEALABLE',
    };
  }

  if (active) {
    return {
      triggerStatus,
      incidentKey,
      blockedAt,
      deadlineAt,
      activeTicket: toRef(active),
      latestTicket: latest ? toRef(latest) : null,
      canAppeal: false,
      blockedReason: 'APPEAL_IN_PROGRESS',
    };
  }

  const incidentTickets = appealTickets.filter(
    (ticket) => ticket.appeal?.incidentKey === incidentKey,
  );
  const finalizedForIncident = incidentTickets.find(
    (ticket) => ticket.status !== SupportTicketStatus.WITHDRAWN,
  );
  if (finalizedForIncident) {
    return {
      triggerStatus,
      incidentKey,
      blockedAt,
      deadlineAt,
      activeTicket: null,
      latestTicket: toRef(finalizedForIncident),
      canAppeal: false,
      blockedReason: 'ALREADY_APPEALED',
    };
  }

  if (now.getTime() > deadlineAt.getTime()) {
    return {
      triggerStatus,
      incidentKey,
      blockedAt,
      deadlineAt,
      activeTicket: null,
      latestTicket: latest ? toRef(latest) : null,
      canAppeal: false,
      blockedReason: 'APPEAL_WINDOW_EXPIRED',
    };
  }

  const withdrawals = incidentTickets.filter(
    (ticket) => ticket.status === SupportTicketStatus.WITHDRAWN,
  ).length;
  if (withdrawals >= maxWithdrawals) {
    return {
      triggerStatus,
      incidentKey,
      blockedAt,
      deadlineAt,
      activeTicket: null,
      latestTicket: latest ? toRef(latest) : null,
      canAppeal: false,
      blockedReason: 'WITHDRAWAL_LIMIT_REACHED',
    };
  }

  return {
    triggerStatus,
    incidentKey,
    blockedAt,
    deadlineAt,
    activeTicket: null,
    latestTicket: latest ? toRef(latest) : null,
    canAppeal: true,
    blockedReason: null,
  };
}

export function buildPostSnapshot(
  post: Post,
  blockedAt: Date,
): AppealPostSnapshot {
  const title = post.blog?.title?.trim() || null;
  const rawExcerpt = (
    post.blog?.excerpt ||
    post.blog?.content ||
    post.body ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const excerpt =
    rawExcerpt.length === 0
      ? null
      : rawExcerpt.length > EXCERPT_MAX_LENGTH
        ? `${rawExcerpt.slice(0, EXCERPT_MAX_LENGTH - 1).trimEnd()}…`
        : rawExcerpt;
  const mod = post.moderation;
  const trigger = appealTriggerStatusOf(post);
  const route = mod?.route ?? null;
  const reason =
    trigger === 'REMOVED'
      ? (post.removal?.reason ?? null)
      : (mod?.reviewNote ?? null);

  return {
    title,
    excerpt,
    verdict: mod?.verdict ?? null,
    reason,
    routeRule: route?.rule ?? null,
    routeAppliedBy: route?.appliedBy ?? null,
    routeCategory: route?.category ?? null,
    blockedAt,
  };
}

export function defaultAppealSubject(post: Post): string {
  const raw = (post.blog?.title || post.body || '').replace(/\s+/g, ' ').trim();
  const max = runtimeConfig.SUPPORT_TICKET_SUBJECT_MAX_LENGTH;
  if (!raw) {
    return post.type === PostType.BLOG
      ? 'Kháng cáo blog bị xử lý'
      : 'Kháng cáo bài viết bị xử lý';
  }
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

export function generateTicketCode(category: SupportTicketCategory): string {
  const prefix =
    category === SupportTicketCategory.CONTENT_APPEAL ? 'APL' : 'TKT';
  const bytes = randomBytes(CODE_LENGTH);
  let suffix = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    suffix += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return `${prefix}-${suffix}`;
}

/**
 * Until when the author may reopen a finished ticket by replying to it.
 * Appeals never reopen: their outcome is tied to the post's moderation state,
 * and a new appeal goes through `evaluateAppealEligibility` instead.
 */
export function reopenDeadlineOf(
  ticket: Pick<SupportTicket, 'category' | 'status' | 'resolvedAt'>,
  windowDays = runtimeConfig.SUPPORT_REOPEN_WINDOW_DAYS,
): Date | null {
  if (ticket.category === SupportTicketCategory.CONTENT_APPEAL) return null;
  if (isTicketActive(ticket.status)) return null;
  if (!ticket.resolvedAt) return null;
  return new Date(ticket.resolvedAt.getTime() + windowDays * MS_PER_DAY);
}

export type AuthorReplyMode = 'REPLY' | 'REOPEN';

export type AuthorReplyBlock =
  'TICKET_ALREADY_CLOSED' | 'TICKET_REOPEN_WINDOW_EXPIRED';

/** Whether the author's next message continues the ticket or reopens it. */
export function authorReplyModeOf(
  ticket: Pick<SupportTicket, 'category' | 'status' | 'resolvedAt'>,
  now: Date = new Date(),
): { mode: AuthorReplyMode } | { blocked: AuthorReplyBlock } {
  if (isTicketActive(ticket.status)) return { mode: 'REPLY' };
  const deadline = reopenDeadlineOf(ticket);
  if (!deadline) return { blocked: 'TICKET_ALREADY_CLOSED' };
  if (now.getTime() > deadline.getTime()) {
    return { blocked: 'TICKET_REOPEN_WINDOW_EXPIRED' };
  }
  return { mode: 'REOPEN' };
}

/**
 * A claimed ticket belongs to its assignee: other admins may add internal
 * notes but not reply publicly or resolve it until they take it over.
 */
export function isClaimedByOther(
  ticket: Pick<SupportTicket, 'assigneeId'>,
  adminId: string,
): boolean {
  return ticket.assigneeId !== null && ticket.assigneeId !== adminId;
}

const MS_PER_HOUR = 3_600_000;

export interface WaitingReminderTimings {
  firstReminderHours: number;
  finalReminderHours: number;
  expireHours: number;
}

export function waitingReminderTimings(): WaitingReminderTimings {
  return {
    firstReminderHours: runtimeConfig.SUPPORT_FIRST_REMINDER_HOURS,
    finalReminderHours: runtimeConfig.SUPPORT_FINAL_REMINDER_HOURS,
    expireHours: runtimeConfig.APPEAL_WAITING_USER_EXPIRE_DAYS * 24,
  };
}

type WaitingTicket = Pick<
  SupportTicket,
  'status' | 'waitingUserSince' | 'waitingReminderCount' | 'lastReminderAt'
>;

/**
 * When a WAITING_USER ticket expires. The final reminder promises the author
 * the full notice period (expire − final hours), so a late reminder pushes
 * the deadline back instead of closing the ticket right after the warning.
 */
export function autoCloseAtOf(
  ticket: WaitingTicket,
  timings: WaitingReminderTimings = waitingReminderTimings(),
): Date | null {
  if (ticket.status !== SupportTicketStatus.WAITING_USER) return null;
  if (!ticket.waitingUserSince) return null;
  const onSchedule =
    ticket.waitingUserSince.getTime() + timings.expireHours * MS_PER_HOUR;
  if (ticket.waitingReminderCount < 2 || !ticket.lastReminderAt) {
    return new Date(onSchedule);
  }
  const noticeHours = timings.expireHours - timings.finalReminderHours;
  const afterNotice =
    ticket.lastReminderAt.getTime() + noticeHours * MS_PER_HOUR;
  return new Date(Math.max(onSchedule, afterNotice));
}

export type WaitingStep = 'FIRST_REMINDER' | 'FINAL_REMINDER' | 'EXPIRE';

/**
 * Zendesk-style "bump, bump, solve": a silent author gets a reminder, then a
 * final warning, and only a ticket that received both can expire.
 */
export function nextWaitingStep(
  ticket: WaitingTicket,
  now: Date,
  timings: WaitingReminderTimings = waitingReminderTimings(),
): WaitingStep | null {
  if (ticket.status !== SupportTicketStatus.WAITING_USER) return null;
  if (!ticket.waitingUserSince) return null;
  const waitedHours =
    (now.getTime() - ticket.waitingUserSince.getTime()) / MS_PER_HOUR;

  if (ticket.waitingReminderCount === 0) {
    if (waitedHours >= timings.firstReminderHours) return 'FIRST_REMINDER';
    return null;
  }
  if (ticket.waitingReminderCount === 1) {
    if (waitedHours >= timings.finalReminderHours) return 'FINAL_REMINDER';
    return null;
  }
  const closeAt = autoCloseAtOf(ticket, timings);
  if (closeAt && now.getTime() >= closeAt.getTime()) return 'EXPIRE';
  return null;
}
