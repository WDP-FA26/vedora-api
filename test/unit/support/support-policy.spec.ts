import {
  appealDeadlineOf,
  appealTriggerStatusOf,
  authorReplyModeOf,
  autoCloseAtOf,
  isClaimedByOther,
  nextWaitingStep,
  reopenDeadlineOf,
  blockedAtOf,
  buildPostSnapshot,
  evaluateAppealEligibility,
  generateTicketCode,
  incidentKeyOf,
} from '../../../src/support/support-policy.js';
import {
  AppealOutcome,
  AppealReasonCategory,
  PostRemovalActor,
  PostStatus,
  PostType,
  SupportSenderRole,
  SupportTicketCategory,
  SupportTicketStatus,
  type Post,
  type SupportTicket,
} from '../../../src/mongo/models.js';

function makePost(overrides: Partial<Post> = {}): Post {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return {
    _id: 'post-1',
    id: 'post-1',
    authorId: 'author-1',
    type: PostType.POST,
    status: PostStatus.REJECTED,
    body: 'Nội dung bài viết thuần chay mẫu',
    draftKind: null,
    draftTitle: '',
    draftDescription: '',
    draftVersion: 0,
    commentRevision: 0,
    blog: null,
    moderation: {
      verdict: 'violence',
      violationScore: 0.92,
      scores: { violence: 0.92 },
      checkedAt: now,
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
      evidence: null,
      route: null,
      heldAt: null,
    },
    removal: null,
    searchIndexedAt: null,
    viewCount: 0,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAppealTicket(
  post: Post,
  overrides: Partial<SupportTicket> = {},
): SupportTicket {
  const blockedAt = blockedAtOf(post) ?? new Date('2026-11-10T10:00:00.000Z');
  return {
    _id: 'ticket-1',
    id: 'ticket-1',
    code: 'APL-ABCDEF',
    category: SupportTicketCategory.CONTENT_APPEAL,
    authorId: post.authorId,
    subject: 'Kháng cáo mẫu',
    status: SupportTicketStatus.OPEN,
    appeal: {
      postId: post.id,
      postType: post.type,
      triggerStatus: appealTriggerStatusOf(post) ?? 'REJECTED',
      incidentKey: incidentKeyOf(post) ?? `REJECTED:${blockedAt.toISOString()}`,
      reasonCategory: AppealReasonCategory.FALSE_POSITIVE,
      outcome: null,
      postSnapshot: buildPostSnapshot(post, blockedAt),
    },
    referenceCode: null,
    lastMessageAt: blockedAt,
    lastMessageByRole: SupportSenderRole.USER,
    messageCount: 1,
    waitingUserSince: null,
    waitingReminderCount: 0,
    lastReminderAt: null,
    assigneeId: null,
    assignedAt: null,
    resolvedById: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: blockedAt,
    updatedAt: blockedAt,
    ...overrides,
  };
}

describe('support-policy', () => {
  it('marks REJECTED and admin-REMOVED posts as appealable, but rejects PUBLISHED and author-REMOVED', () => {
    expect(
      appealTriggerStatusOf(makePost({ status: PostStatus.REJECTED })),
    ).toBe('REJECTED');
    expect(
      appealTriggerStatusOf(
        makePost({
          status: PostStatus.REMOVED,
          removal: {
            removedById: 'admin-1',
            removedByRole: PostRemovalActor.ADMIN,
            removedAt: new Date('2026-11-12T00:00:00.000Z'),
            previousStatus: PostStatus.PUBLISHED,
            reason: 'SPAM',
            restoredById: null,
            restoredAt: null,
          },
        }),
      ),
    ).toBe('REMOVED');
    expect(
      appealTriggerStatusOf(
        makePost({
          status: PostStatus.REMOVED,
          removal: {
            removedById: 'author-1',
            removedByRole: PostRemovalActor.AUTHOR,
            removedAt: new Date('2026-11-12T00:00:00.000Z'),
            previousStatus: PostStatus.PUBLISHED,
            reason: null,
            restoredById: null,
            restoredAt: null,
          },
        }),
      ),
    ).toBeNull();
  });

  it('enforces 14-day window, active lock, finalized incident block, and withdrawal cap', () => {
    const post = makePost();
    const blockedAt = blockedAtOf(post)!;
    const deadline = appealDeadlineOf(blockedAt, 14);

    expect(
      evaluateAppealEligibility(post, [], new Date(deadline.getTime() - 1000))
        .canAppeal,
    ).toBe(true);
    expect(
      evaluateAppealEligibility(post, [], new Date(deadline.getTime() + 1000))
        .blockedReason,
    ).toBe('APPEAL_WINDOW_EXPIRED');

    const now = new Date('2026-11-11T10:00:00.000Z');
    expect(
      evaluateAppealEligibility(
        post,
        [makeAppealTicket(post, { status: SupportTicketStatus.WAITING_USER })],
        now,
      ).blockedReason,
    ).toBe('APPEAL_IN_PROGRESS');

    expect(
      evaluateAppealEligibility(
        post,
        [
          makeAppealTicket(post, {
            status: SupportTicketStatus.RESOLVED,
            appeal: {
              ...makeAppealTicket(post).appeal!,
              outcome: AppealOutcome.REJECTED,
            },
          }),
        ],
        now,
      ).blockedReason,
    ).toBe('ALREADY_APPEALED');

    expect(
      evaluateAppealEligibility(
        post,
        [
          makeAppealTicket(post, {
            id: 't-1',
            status: SupportTicketStatus.WITHDRAWN,
          }),
          makeAppealTicket(post, {
            id: 't-2',
            status: SupportTicketStatus.WITHDRAWN,
          }),
        ],
        now,
        { maxWithdrawalsPerIncident: 2 },
      ).blockedReason,
    ).toBe('WITHDRAWAL_LIMIT_REACHED');
  });

  it('generates APL- codes for content appeals and TKT- codes for general support', () => {
    expect(generateTicketCode(SupportTicketCategory.CONTENT_APPEAL)).toMatch(
      /^APL-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/,
    );
    expect(generateTicketCode(SupportTicketCategory.PAYMENT_ISSUE)).toMatch(
      /^TKT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/,
    );
    expect(generateTicketCode(SupportTicketCategory.GENERAL)).toMatch(
      /^TKT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/,
    );
  });
});

describe('reopenDeadlineOf / authorReplyModeOf', () => {
  const resolvedAt = new Date('2026-11-01T00:00:00.000Z');
  const finished = {
    category: SupportTicketCategory.PAYMENT_ISSUE,
    status: SupportTicketStatus.RESOLVED,
    resolvedAt,
  };

  it('keeps replying to an active ticket', () => {
    const active = {
      ...finished,
      status: SupportTicketStatus.OPEN,
      resolvedAt: null,
    };
    expect(reopenDeadlineOf(active)).toBeNull();
    expect(authorReplyModeOf(active)).toEqual({ mode: 'REPLY' });
  });

  it('reopens a finished ticket inside the window, then refuses', () => {
    expect(reopenDeadlineOf(finished, 30)).toEqual(
      new Date('2026-12-01T00:00:00.000Z'),
    );
    expect(
      authorReplyModeOf(finished, new Date('2026-11-20T00:00:00.000Z')),
    ).toEqual({ mode: 'REOPEN' });
    expect(
      authorReplyModeOf(finished, new Date('2026-12-02T00:00:00.000Z')),
    ).toEqual({ blocked: 'TICKET_REOPEN_WINDOW_EXPIRED' });
  });

  it('never reopens a content appeal', () => {
    const appeal = {
      ...finished,
      category: SupportTicketCategory.CONTENT_APPEAL,
    };
    expect(reopenDeadlineOf(appeal)).toBeNull();
    expect(authorReplyModeOf(appeal, resolvedAt)).toEqual({
      blocked: 'TICKET_ALREADY_CLOSED',
    });
  });
});

describe('isClaimedByOther', () => {
  it('only blocks admins other than the assignee', () => {
    expect(isClaimedByOther({ assigneeId: null }, 'admin-a')).toBe(false);
    expect(isClaimedByOther({ assigneeId: 'admin-a' }, 'admin-a')).toBe(false);
    expect(isClaimedByOther({ assigneeId: 'admin-a' }, 'admin-b')).toBe(true);
  });
});

describe('nextWaitingStep (bump, bump, solve)', () => {
  const timings = {
    firstReminderHours: 48,
    finalReminderHours: 120,
    expireHours: 168,
  };
  const since = new Date('2026-11-01T00:00:00.000Z');
  const hoursAfter = (hours: number) =>
    new Date(since.getTime() + hours * 3_600_000);
  const waiting = (count: number, lastReminderAt: Date | null = null) => ({
    status: SupportTicketStatus.WAITING_USER,
    waitingUserSince: since,
    waitingReminderCount: count,
    lastReminderAt,
  });

  it('reminds at 48h, warns at 120h and expires at 168h', () => {
    expect(nextWaitingStep(waiting(0), hoursAfter(47), timings)).toBeNull();
    expect(nextWaitingStep(waiting(0), hoursAfter(48), timings)).toBe(
      'FIRST_REMINDER',
    );
    expect(
      nextWaitingStep(waiting(1, hoursAfter(48)), hoursAfter(119), timings),
    ).toBeNull();
    expect(
      nextWaitingStep(waiting(1, hoursAfter(48)), hoursAfter(120), timings),
    ).toBe('FINAL_REMINDER');
    expect(
      nextWaitingStep(waiting(2, hoursAfter(120)), hoursAfter(167), timings),
    ).toBeNull();
    expect(
      nextWaitingStep(waiting(2, hoursAfter(120)), hoursAfter(168), timings),
    ).toBe('EXPIRE');
  });

  it('never expires a ticket that skipped its reminders', () => {
    expect(nextWaitingStep(waiting(0), hoursAfter(400), timings)).toBe(
      'FIRST_REMINDER',
    );
    expect(
      nextWaitingStep(waiting(1, hoursAfter(400)), hoursAfter(400), timings),
    ).toBe('FINAL_REMINDER');
  });

  it('gives the full 48h notice after a late final warning', () => {
    const late = waiting(2, hoursAfter(160));
    expect(autoCloseAtOf(late, timings)).toEqual(hoursAfter(208));
    expect(nextWaitingStep(late, hoursAfter(200), timings)).toBeNull();
    expect(nextWaitingStep(late, hoursAfter(208), timings)).toBe('EXPIRE');
  });

  it('does nothing for tickets that are not waiting on the author', () => {
    const open = { ...waiting(0), status: SupportTicketStatus.OPEN };
    expect(nextWaitingStep(open, hoursAfter(500), timings)).toBeNull();
    expect(autoCloseAtOf(open, timings)).toBeNull();
  });
});
