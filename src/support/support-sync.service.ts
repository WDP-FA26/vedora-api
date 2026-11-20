import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import {
  AppealOutcome,
  SupportMessage,
  SupportMessageKind,
  SupportSenderRole,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  type Post,
} from '../mongo/models.js';
import {
  ACTIVE_TICKET_STATUSES,
  appealTriggerStatusOf,
  evaluateAppealEligibility,
} from './support-policy.js';
import type { PostAppealSummaryDto } from './dto/post-appeal-summary.dto.js';

export interface CloseActiveAppealParams {
  postId: string;
  adminId: string;
  outcome: AppealOutcome;
  note: string | null;
  now: Date;
}

@Injectable()
export class SupportSyncService {
  constructor(
    @InjectModel(SupportTicket.name)
    private readonly tickets: Model<SupportTicket>,
    @InjectModel(SupportMessage.name)
    private readonly messages: Model<SupportMessage>,
  ) {}

  async hasActiveAppeal(
    postId: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.tickets.exists({
      category: SupportTicketCategory.CONTENT_APPEAL,
      'appeal.postId': postId,
      status: { $in: [...ACTIVE_TICKET_STATUSES] },
    });
    if (session) query.session(session);
    const found = await query.exec();
    return found !== null;
  }

  async assertNoActiveAppeal(
    postId: string,
    session?: ClientSession,
  ): Promise<void> {
    if (await this.hasActiveAppeal(postId, session)) {
      throw new StateConflictException(
        'APPEAL_IN_PROGRESS',
        'This post has an active appeal ticket. Withdraw the appeal before editing or deleting it',
      );
    }
  }

  async summarizeAppealsForPosts(
    posts: readonly Post[],
    viewerId?: string,
  ): Promise<Map<string, PostAppealSummaryDto>> {
    const result = new Map<string, PostAppealSummaryDto>();
    if (!viewerId) return result;
    const candidates = posts.filter(
      (post) =>
        post.authorId === viewerId && appealTriggerStatusOf(post) !== null,
    );
    if (candidates.length === 0) return result;

    const postIds = candidates.map((post) => post.id);
    const rows = await this.tickets
      .find({
        category: SupportTicketCategory.CONTENT_APPEAL,
        'appeal.postId': { $in: postIds },
      })
      .sort({ createdAt: -1, _id: -1 })
      .exec();

    const byPostId = new Map<string, SupportTicket[]>();
    for (const row of rows) {
      const postId = row.appeal?.postId;
      if (!postId) continue;
      const list = byPostId.get(postId);
      if (list) list.push(row);
      else byPostId.set(postId, [row]);
    }

    const now = new Date();
    for (const post of candidates) {
      const eligibility = evaluateAppealEligibility(
        post,
        byPostId.get(post.id) ?? [],
        now,
      );
      result.set(post.id, {
        activeTicket: eligibility.activeTicket,
        latestTicket: eligibility.latestTicket,
        canAppeal: eligibility.canAppeal,
        deadlineAt: eligibility.deadlineAt,
        blockedReason: eligibility.blockedReason,
      });
    }
    return result;
  }

  async closeActiveAppealOnAdminAction(
    session: ClientSession,
    params: CloseActiveAppealParams,
  ): Promise<SupportTicket | null> {
    const approved = params.outcome === AppealOutcome.APPROVED;
    const kind = approved
      ? SupportMessageKind.DECISION_APPROVED
      : SupportMessageKind.DECISION_REJECTED;
    const defaultBody = approved
      ? 'Quản trị viên đã chấp thuận kháng cáo và khôi phục bài viết.'
      : 'Quản trị viên đã giữ nguyên quyết định xử lý bài viết.';
    const body = params.note?.trim() || defaultBody;

    const updated = await this.tickets
      .findOneAndUpdate(
        {
          category: SupportTicketCategory.CONTENT_APPEAL,
          'appeal.postId': params.postId,
          status: { $in: [...ACTIVE_TICKET_STATUSES] },
        },
        {
          $set: {
            status: SupportTicketStatus.RESOLVED,
            'appeal.outcome': params.outcome,
            waitingUserSince: null,
            waitingReminderCount: 0,
            lastReminderAt: null,
            resolvedById: params.adminId,
            resolvedAt: params.now,
            resolutionNote: params.note?.trim() || null,
            lastMessageAt: params.now,
            lastMessageByRole: SupportSenderRole.ADMIN,
          },
          $inc: { messageCount: 1 },
        },
        { returnDocument: 'after', session },
      )
      .exec();

    if (!updated) return null;

    await this.messages.create(
      [
        {
          ticketId: updated.id,
          senderId: params.adminId,
          senderRole: SupportSenderRole.ADMIN,
          kind,
          isInternal: false,
          body,
        },
      ],
      { session },
    );

    return updated;
  }
}
