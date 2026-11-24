import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../config/runtime-config.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import {
  type StateConflictCode,
  StateConflictException,
} from '../common/exceptions/state-conflict.exception.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  type PaginatedResponseDto,
} from '../common/pagination/index.js';
import { lockDocument } from '../mongo/document-lock.js';
import { isUniqueViolation } from '../mongo/errors.js';
import {
  AppealReasonCategory,
  Post,
  PostRemovalActor,
  PostStatus,
  SupportMessage,
  SupportMessageKind,
  SupportSenderRole,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketStatus,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { PostsQueryService } from '../posts/posts-query.service.js';
import {
  ACTIVE_TICKET_STATUSES,
  buildPostSnapshot,
  defaultAppealSubject,
  evaluateAppealEligibility,
  generateTicketCode,
  authorReplyModeOf,
  autoCloseAtOf,
  isTicketActive,
  reopenDeadlineOf,
  type AppealBlockedReason,
} from './support-policy.js';
import { SupportAttachmentsService } from './support-attachments.service.js';
import {
  type CreateSupportMessageDto,
  type CreateSupportTicketDto,
  type ListMyTicketsQueryDto,
  type SupportAttachmentDto,
  type SupportMessageDto,
  type SupportTicketDetailDto,
  type SupportTicketListItemDto,
} from './dto/support.dto.js';

const BLOCKED_MESSAGES: Record<
  AppealBlockedReason,
  { code: StateConflictCode; message: string }
> = {
  NOT_APPEALABLE: {
    code: 'POST_NOT_APPEALABLE',
    message: 'Only rejected or admin-removed posts can be appealed',
  },
  APPEAL_IN_PROGRESS: {
    code: 'APPEAL_IN_PROGRESS',
    message: 'This post already has an active appeal ticket',
  },
  APPEAL_WINDOW_EXPIRED: {
    code: 'APPEAL_WINDOW_EXPIRED',
    message: `Appeals must be submitted within ${runtimeConfig.APPEAL_WINDOW_DAYS} days of the decision`,
  },
  ALREADY_APPEALED: {
    code: 'ALREADY_APPEALED',
    message: 'An appeal has already been decided for this moderation incident',
  },
  WITHDRAWAL_LIMIT_REACHED: {
    code: 'WITHDRAWAL_LIMIT_REACHED',
    message:
      'You have reached the withdrawal limit for this moderation incident',
  },
};

export function toAuthorSummary(user: User) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    isProfessional: user.isProfessional,
  };
}

export function toTicketListItem(
  ticket: SupportTicket,
): SupportTicketListItemDto {
  return {
    id: ticket.id,
    code: ticket.code,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    appeal: ticket.appeal
      ? {
          postId: ticket.appeal.postId,
          postType: ticket.appeal.postType,
          triggerStatus: ticket.appeal.triggerStatus,
          reasonCategory: ticket.appeal.reasonCategory,
          outcome: ticket.appeal.outcome,
          postSnapshot: {
            title: ticket.appeal.postSnapshot.title,
            excerpt: ticket.appeal.postSnapshot.excerpt,
            verdict: ticket.appeal.postSnapshot.verdict,
            reason: ticket.appeal.postSnapshot.reason,
            blockedAt: ticket.appeal.postSnapshot.blockedAt,
          },
        }
      : null,
    referenceCode: ticket.referenceCode,
    lastMessageAt: ticket.lastMessageAt,
    lastMessageByRole: ticket.lastMessageByRole,
    messageCount: ticket.messageCount,
    waitingUserSince: ticket.waitingUserSince,
    autoCloseAt: autoCloseAtOf(ticket),
    resolvedAt: ticket.resolvedAt,
    resolutionNote: ticket.resolutionNote,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function toSupportMessageDto(
  message: SupportMessage,
  usersById: ReadonlyMap<string, User>,
  attachmentsByMessage: ReadonlyMap<string, SupportAttachmentDto[]>,
): SupportMessageDto {
  const sender = message.senderId
    ? (usersById.get(message.senderId) ?? null)
    : null;
  return {
    id: message.id,
    ticketId: message.ticketId,
    sender: sender ? toAuthorSummary(sender) : null,
    senderRole: message.senderRole,
    kind: message.kind,
    isInternal: message.isInternal,
    body: message.body,
    attachments: attachmentsByMessage.get(message.id) ?? [],
    createdAt: message.createdAt,
  };
}

/** The reopen deadline, or null once it has passed (or never applied). */
function openReopenDeadline(ticket: SupportTicket): Date | null {
  const deadline = reopenDeadlineOf(ticket);
  if (!deadline || deadline.getTime() <= Date.now()) return null;
  return deadline;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly mongo: MongoService,
    private readonly postsQuery: PostsQueryService,
    @InjectModel(SupportTicket.name)
    private readonly tickets: Model<SupportTicket>,
    @InjectModel(SupportMessage.name)
    private readonly messages: Model<SupportMessage>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly attachments: SupportAttachmentsService,
  ) {}

  async create(
    authorId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicketDetailDto> {
    if (dto.category === SupportTicketCategory.CONTENT_APPEAL) {
      return this.createContentAppeal(authorId, dto);
    }
    return this.createGeneralTicket(authorId, dto);
  }

  private async createContentAppeal(
    authorId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicketDetailDto> {
    if (!dto.postId) {
      throw new InvalidInputException(
        'TICKET_POST_REQUIRED',
        'postId is required for CONTENT_APPEAL tickets',
      );
    }
    const postId = dto.postId;
    const attachmentIds = dto.attachmentIds ?? [];
    await this.attachments.assertReady(authorId, attachmentIds);
    const firstMessageId = randomUUID();
    let createdId = '';

    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', postId);
      const post = await this.posts
        .findOne({ _id: postId })
        .session(session)
        .exec();
      const authorDeleted =
        post?.status === PostStatus.REMOVED &&
        post.removal?.removedByRole === PostRemovalActor.AUTHOR;
      if (!post || authorDeleted) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (post.authorId !== authorId) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'Only the author can appeal this post',
        );
      }

      await this.assertWithinActiveLimit(authorId, session);

      const existing = await this.tickets
        .find({
          category: SupportTicketCategory.CONTENT_APPEAL,
          'appeal.postId': post.id,
        })
        .sort({ createdAt: -1, _id: -1 })
        .session(session)
        .exec();
      const now = new Date();
      const eligibility = evaluateAppealEligibility(post, existing, now);
      if (
        !eligibility.canAppeal ||
        !eligibility.triggerStatus ||
        !eligibility.incidentKey ||
        !eligibility.blockedAt
      ) {
        const reason = eligibility.blockedReason ?? 'NOT_APPEALABLE';
        const errorInfo = BLOCKED_MESSAGES[reason];
        throw new StateConflictException(errorInfo.code, errorInfo.message);
      }

      const id = randomUUID();
      const subject = dto.subject?.trim() || defaultAppealSubject(post);
      const snapshot = buildPostSnapshot(post, eligibility.blockedAt);

      const created = await this.createWithUniqueCode(
        session,
        SupportTicketCategory.CONTENT_APPEAL,
        {
          _id: id,
          category: SupportTicketCategory.CONTENT_APPEAL,
          authorId,
          subject,
          status: SupportTicketStatus.OPEN,
          appeal: {
            postId: post.id,
            postType: post.type,
            triggerStatus: eligibility.triggerStatus,
            incidentKey: eligibility.incidentKey,
            reasonCategory: dto.reasonCategory ?? AppealReasonCategory.OTHER,
            outcome: null,
            postSnapshot: snapshot,
          },
          referenceCode: null,
          lastMessageAt: now,
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
        },
      );

      await this.messages.create(
        [
          {
            _id: firstMessageId,
            ticketId: created.id,
            senderId: authorId,
            senderRole: SupportSenderRole.USER,
            kind: SupportMessageKind.MESSAGE,
            isInternal: false,
            body: dto.message,
          },
        ],
        { session },
      );
      await this.attachments.attach(session, authorId, attachmentIds, {
        ticketId: created.id,
        messageId: firstMessageId,
      });

      createdId = created.id;
    });

    return this.getOne(createdId, authorId);
  }

  private async createGeneralTicket(
    authorId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicketDetailDto> {
    const subject = dto.subject?.trim() ?? '';
    if (!subject) {
      throw new InvalidInputException(
        'TICKET_SUBJECT_REQUIRED',
        'Please provide a subject for this support ticket',
      );
    }

    const attachmentIds = dto.attachmentIds ?? [];
    await this.attachments.assertReady(authorId, attachmentIds);
    const firstMessageId = randomUUID();
    let createdId = '';

    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', authorId);
      await this.assertWithinActiveLimit(authorId, session);

      const now = new Date();
      const created = await this.createWithUniqueCode(session, dto.category, {
        _id: randomUUID(),
        category: dto.category,
        authorId,
        subject,
        status: SupportTicketStatus.OPEN,
        appeal: null,
        referenceCode: dto.referenceCode?.trim() || null,
        lastMessageAt: now,
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
      });

      await this.messages.create(
        [
          {
            _id: firstMessageId,
            ticketId: created.id,
            senderId: authorId,
            senderRole: SupportSenderRole.USER,
            kind: SupportMessageKind.MESSAGE,
            isInternal: false,
            body: dto.message,
          },
        ],
        { session },
      );
      await this.attachments.attach(session, authorId, attachmentIds, {
        ticketId: created.id,
        messageId: firstMessageId,
      });

      createdId = created.id;
    });

    return this.getOne(createdId, authorId);
  }

  async listMine(
    authorId: string,
    query: ListMyTicketsQueryDto,
  ): Promise<PaginatedResponseDto<SupportTicketListItemDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter: QueryFilter<SupportTicket> = { authorId };
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;

    const [rows, totalItems] = await Promise.all([
      this.tickets
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.tickets.countDocuments(filter).exec(),
    ]);

    return createPaginatedResponse(
      rows.map((row) => toTicketListItem(row)),
      totalItems,
      query,
    );
  }

  async getOne(id: string, authorId: string): Promise<SupportTicketDetailDto> {
    const ticket = await this.tickets.findOne({ _id: id }).exec();
    if (!ticket) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
    }
    if (ticket.authorId !== authorId) {
      throw new AccessDeniedException(
        'FORBIDDEN',
        'You can only view your own support tickets',
      );
    }

    const postId = ticket.appeal?.postId ?? null;
    const [messages, post] = await Promise.all([
      this.messages
        .find({ ticketId: ticket.id, isInternal: false })
        .sort({ createdAt: 1, _id: 1 })
        .exec(),
      postId
        ? this.posts.findOne({ _id: postId }).exec()
        : Promise.resolve(null),
    ]);

    const senderIds = [
      ...new Set(
        messages.flatMap((msg) => (msg.senderId ? [msg.senderId] : [])),
      ),
    ];
    const senders =
      senderIds.length > 0
        ? await this.users.find({ _id: { $in: senderIds } }).exec()
        : [];
    const usersById = new Map(senders.map((user) => [user.id, user]));
    // Only public messages were loaded, so internal-note images never get a URL.
    const attachmentsByMessage = await this.attachments.forMessages(
      messages.map((msg) => msg.id),
    );

    const visiblePost =
      post &&
      !(
        post.status === PostStatus.REMOVED &&
        post.removal?.removedByRole === PostRemovalActor.AUTHOR
      )
        ? ((await this.postsQuery.toResponses([post], authorId))[0] ?? null)
        : null;

    return {
      ...toTicketListItem(ticket),
      messages: messages.map((msg) =>
        toSupportMessageDto(msg, usersById, attachmentsByMessage),
      ),
      post: visiblePost,
      reopenableUntil: openReopenDeadline(ticket),
    };
  }

  async reply(
    id: string,
    authorId: string,
    dto: CreateSupportMessageDto,
  ): Promise<SupportTicketDetailDto> {
    const body = dto.body ?? '';
    const attachmentIds = dto.attachmentIds ?? [];
    if (!body && attachmentIds.length === 0) {
      throw new InvalidInputException(
        'TICKET_MESSAGE_EMPTY',
        'Write a message or attach an image',
      );
    }
    await this.attachments.assertReady(authorId, attachmentIds);

    await this.mongo.withTransaction(async (session) => {
      // The user lock guards the active-ticket limit a reopen has to respect.
      await lockDocument(this.mongo, session, 'user', authorId);
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (ticket.authorId !== authorId) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'You can only reply to your own support tickets',
        );
      }

      const now = new Date();
      const replyMode = authorReplyModeOf(ticket, now);
      if ('blocked' in replyMode) {
        throw this.replyBlockedError(replyMode.blocked);
      }
      const reopening = replyMode.mode === 'REOPEN';
      const added = reopening ? 2 : 1;
      if (
        ticket.messageCount + added >
        runtimeConfig.APPEAL_MAX_MESSAGES_PER_TICKET
      ) {
        throw new StateConflictException(
          'TICKET_MESSAGE_LIMIT_REACHED',
          'This support ticket has reached its message limit',
        );
      }

      if (reopening) {
        await this.assertWithinActiveLimit(authorId, session);
      } else {
        await this.assertNotWaitingForAdmin(ticket.id, session);
      }

      if (reopening) {
        await this.messages.create(
          [
            {
              ticketId: ticket.id,
              senderId: authorId,
              senderRole: SupportSenderRole.USER,
              kind: SupportMessageKind.REOPENED,
              isInternal: false,
              body: 'Người dùng đã mở lại hồ sơ.',
            },
          ],
          { session },
        );
      }

      const messageId = randomUUID();
      await this.messages.create(
        [
          {
            _id: messageId,
            ticketId: ticket.id,
            senderId: authorId,
            senderRole: SupportSenderRole.USER,
            kind: SupportMessageKind.MESSAGE,
            isInternal: false,
            body,
          },
        ],
        { session },
      );
      await this.attachments.attach(session, authorId, attachmentIds, {
        ticketId: ticket.id,
        messageId,
      });

      // A reopened ticket keeps its assignee but loses the old resolution.
      const reopenFields = reopening
        ? { resolvedById: null, resolvedAt: null, resolutionNote: null }
        : {};
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          {
            $set: {
              status: SupportTicketStatus.OPEN,
              waitingUserSince: null,
              waitingReminderCount: 0,
              lastReminderAt: null,
              lastMessageAt: now,
              lastMessageByRole: SupportSenderRole.USER,
              ...reopenFields,
            },
            $inc: { messageCount: added },
          },
          { session },
        )
        .exec();
    });

    return this.getOne(id, authorId);
  }

  private replyBlockedError(
    reason: 'TICKET_ALREADY_CLOSED' | 'TICKET_REOPEN_WINDOW_EXPIRED',
  ): StateConflictException {
    if (reason === 'TICKET_REOPEN_WINDOW_EXPIRED') {
      return new StateConflictException(
        'TICKET_REOPEN_WINDOW_EXPIRED',
        `Closed tickets can be reopened for ${runtimeConfig.SUPPORT_REOPEN_WINDOW_DAYS} days; please open a new ticket`,
      );
    }
    return new StateConflictException(
      'TICKET_ALREADY_CLOSED',
      'This support ticket is already closed',
    );
  }

  /** The author may send a few messages in a row, then waits for an admin. */
  private async assertNotWaitingForAdmin(
    ticketId: string,
    session: ClientSession,
  ): Promise<void> {
    const limit = runtimeConfig.APPEAL_MAX_CONSECUTIVE_USER_MESSAGES;
    const recent = await this.messages
      .find({ ticketId, isInternal: false })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .session(session)
      .exec();
    const allByUser =
      recent.length >= limit &&
      recent.every((item) => item.senderRole === SupportSenderRole.USER);
    if (allByUser) {
      throw new StateConflictException(
        'TICKET_WAIT_FOR_ADMIN',
        'Please wait for an administrator to reply before sending more messages',
      );
    }
  }

  async withdraw(
    id: string,
    authorId: string,
  ): Promise<SupportTicketDetailDto> {
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (ticket.authorId !== authorId) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'You can only withdraw your own support tickets',
        );
      }
      if (!isTicketActive(ticket.status)) {
        throw new StateConflictException(
          'TICKET_ALREADY_CLOSED',
          'This support ticket is already closed',
        );
      }

      const now = new Date();
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          {
            $set: {
              status: SupportTicketStatus.WITHDRAWN,
              waitingUserSince: null,
              waitingReminderCount: 0,
              lastReminderAt: null,
              resolvedById: authorId,
              resolvedAt: now,
              lastMessageAt: now,
              lastMessageByRole: SupportSenderRole.USER,
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
            senderId: authorId,
            senderRole: SupportSenderRole.USER,
            kind: SupportMessageKind.WITHDRAWN,
            isInternal: false,
            body:
              ticket.category === SupportTicketCategory.CONTENT_APPEAL
                ? 'Tác giả đã rút yêu cầu kháng cáo.'
                : 'Người dùng đã rút yêu cầu hỗ trợ.',
          },
        ],
        { session },
      );
    });

    return this.getOne(id, authorId);
  }

  private async assertWithinActiveLimit(
    authorId: string,
    session: ClientSession,
  ): Promise<void> {
    const activeCount = await this.tickets
      .countDocuments({
        authorId,
        status: { $in: [...ACTIVE_TICKET_STATUSES] },
      })
      .session(session)
      .exec();
    if (activeCount >= runtimeConfig.APPEAL_MAX_ACTIVE_PER_USER) {
      throw new StateConflictException(
        'TICKET_LIMIT_REACHED',
        `You can have at most ${runtimeConfig.APPEAL_MAX_ACTIVE_PER_USER} active support tickets at a time`,
      );
    }
  }

  private async createWithUniqueCode(
    session: ClientSession,
    category: SupportTicketCategory,
    payload: Omit<SupportTicket, 'id' | 'code' | 'createdAt' | 'updatedAt'>,
  ): Promise<SupportTicket> {
    const attempts = runtimeConfig.APPEAL_CODE_ALLOCATION_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code = generateTicketCode(category);
      try {
        const [created] = await this.tickets.create([{ ...payload, code }], {
          session,
        });
        return created;
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('code_1') && attempt + 1 < attempts) {
          continue;
        }
        throw new StateConflictException(
          'APPEAL_IN_PROGRESS',
          'An appeal ticket already exists for this post incident',
        );
      }
    }
    throw new StateConflictException(
      'TICKET_CODE_COLLISION',
      'Could not allocate a ticket code, please try again',
    );
  }
}
