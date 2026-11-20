import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { runtimeConfig } from '../config/runtime-config.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
} from '../common/pagination/index.js';
import { CaptionService } from '../media/captions/caption.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  AppealOutcome,
  NotificationType,
  Post,
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
import { NotificationsService } from '../notifications/notifications.service.js';
import { AdminPostsService } from '../posts/admin/admin-posts.service.js';
import type { AdminPostDto } from '../posts/dto/admin-post.dto.js';
import { PostSearchIndexService } from '../posts/search/post-search-index.service.js';
import { isClaimedByOther, isTicketActive } from './support-policy.js';
import { SupportAttachmentsService } from './support-attachments.service.js';
import {
  toAuthorSummary,
  toSupportMessageDto,
  toTicketListItem,
} from './support.service.js';
import {
  type AdminCreateSupportMessageDto,
  type AdminListTicketsQueryDto,
  type AdminSupportCategoryCountsDto,
  type AdminSupportStatusCountsDto,
  type AdminSupportTicketDetailDto,
  type AdminSupportTicketListItemDto,
  type AdminSupportTicketsPageDto,
  type ClaimSupportTicketDto,
  type ResolveSupportTicketDto,
} from './dto/support.dto.js';

const MIN_REJECT_NOTE_LENGTH = 5;
const REPLY_NOTIFICATION_EXCERPT_LENGTH = 120;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function claimedByOtherError(): StateConflictException {
  return new StateConflictException(
    'TICKET_CLAIMED_BY_OTHER',
    'Another administrator is handling this ticket; take it over first',
  );
}

function excerptReply(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= REPLY_NOTIFICATION_EXCERPT_LENGTH) return compact;
  return `${compact.slice(0, REPLY_NOTIFICATION_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly mongo: MongoService,
    private readonly adminPosts: AdminPostsService,
    private readonly searchIndex: PostSearchIndexService,
    private readonly captions: CaptionService,
    private readonly notifications: NotificationsService,
    @InjectModel(SupportTicket.name)
    private readonly tickets: Model<SupportTicket>,
    @InjectModel(SupportMessage.name)
    private readonly messages: Model<SupportMessage>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly attachments: SupportAttachmentsService,
  ) {}

  async list(
    query: AdminListTicketsQueryDto,
    adminId: string,
  ): Promise<AdminSupportTicketsPageDto> {
    const { skip, take } = getPaginationArgs(query);
    const filter: QueryFilter<SupportTicket> = {};
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    if (query.triggerStatus) {
      filter['appeal.triggerStatus'] = query.triggerStatus;
    }
    if (query.assignee === 'me') filter.assigneeId = adminId;
    if (query.assignee === 'unassigned') filter.assigneeId = null;
    if (query.q) {
      const regex = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [
        { code: regex },
        { subject: regex },
        { referenceCode: regex },
        { 'appeal.postSnapshot.title': regex },
        { 'appeal.postSnapshot.excerpt': regex },
      ];
    }

    const fifo =
      query.status === SupportTicketStatus.OPEN ||
      query.status === SupportTicketStatus.WAITING_USER;
    const sort: Record<string, 1 | -1> = fifo
      ? { lastMessageAt: 1, _id: 1 }
      : { updatedAt: -1, _id: -1 };

    const [rows, totalItems, counts, categoryCounts] = await Promise.all([
      this.tickets.find(filter).sort(sort).skip(skip).limit(take).exec(),
      this.tickets.countDocuments(filter).exec(),
      this.statusCounts(query.category),
      this.categoryCounts(),
    ]);

    const items = await this.hydrateListItems(rows);
    return {
      ...createPaginatedResponse(items, totalItems, query),
      counts,
      categoryCounts,
    };
  }

  async getOne(id: string): Promise<AdminSupportTicketDetailDto> {
    const ticket = await this.tickets.findOne({ _id: id }).exec();
    if (!ticket) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
    }

    const postId = ticket.appeal?.postId ?? null;
    const [messages, hydratedItems, post] = await Promise.all([
      this.messages
        .find({ ticketId: ticket.id })
        .sort({ createdAt: 1, _id: 1 })
        .exec(),
      this.hydrateListItems([ticket]),
      postId ? this.loadAdminPost(postId) : Promise.resolve(null),
    ]);

    const base = hydratedItems[0];
    if (!base) {
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Ticket author not found',
      );
    }

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
    const attachmentsByMessage = await this.attachments.forMessages(
      messages.map((msg) => msg.id),
    );

    return {
      ...base,
      messages: messages.map((msg) =>
        toSupportMessageDto(msg, usersById, attachmentsByMessage),
      ),
      post,
    };
  }

  async reply(
    id: string,
    adminId: string,
    dto: AdminCreateSupportMessageDto,
  ): Promise<AdminSupportTicketDetailDto> {
    const isInternal = dto.isInternal === true;
    const body = dto.body ?? '';
    const attachmentIds = dto.attachmentIds ?? [];
    if (!body && attachmentIds.length === 0) {
      throw new InvalidInputException(
        'TICKET_MESSAGE_EMPTY',
        'Write a message or attach an image',
      );
    }
    await this.attachments.assertReady(adminId, attachmentIds);
    let notifyTarget: { authorId: string; postId: string | null } | null = null;

    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }

      const messageId = randomUUID();
      // Any admin may leave an internal note, on any ticket, open or closed.
      if (isInternal) {
        await this.messages.create(
          [
            {
              _id: messageId,
              ticketId: ticket.id,
              senderId: adminId,
              senderRole: SupportSenderRole.ADMIN,
              kind: SupportMessageKind.MESSAGE,
              isInternal: true,
              body,
            },
          ],
          { session },
        );
        await this.attachments.attach(session, adminId, attachmentIds, {
          ticketId: ticket.id,
          messageId,
        });
        return;
      }

      if (!isTicketActive(ticket.status)) {
        throw new StateConflictException(
          'TICKET_ALREADY_CLOSED',
          'This support ticket is already closed',
        );
      }
      if (isClaimedByOther(ticket, adminId)) throw claimedByOtherError();
      if (ticket.messageCount >= runtimeConfig.APPEAL_MAX_MESSAGES_PER_TICKET) {
        throw new StateConflictException(
          'TICKET_MESSAGE_LIMIT_REACHED',
          'This support ticket has reached its message limit',
        );
      }

      const now = new Date();
      await this.messages.create(
        [
          {
            _id: messageId,
            ticketId: ticket.id,
            senderId: adminId,
            senderRole: SupportSenderRole.ADMIN,
            kind: SupportMessageKind.MESSAGE,
            isInternal: false,
            body,
          },
        ],
        { session },
      );
      await this.attachments.attach(session, adminId, attachmentIds, {
        ticketId: ticket.id,
        messageId,
      });

      // Replying to an unclaimed ticket claims it for the replying admin.
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          {
            $set: {
              status: SupportTicketStatus.WAITING_USER,
              waitingUserSince: now,
              waitingReminderCount: 0,
              lastReminderAt: null,
              lastMessageAt: now,
              lastMessageByRole: SupportSenderRole.ADMIN,
              assigneeId: adminId,
              assignedAt: ticket.assignedAt ?? now,
            },
            $inc: { messageCount: 1 },
          },
          { session },
        )
        .exec();

      notifyTarget = {
        authorId: ticket.authorId,
        postId: ticket.appeal?.postId ?? null,
      };
    });

    if (notifyTarget !== null) {
      const target: { authorId: string; postId: string | null } = notifyTarget;
      const note = body ? excerptReply(body) : 'Quản trị viên đã gửi hình ảnh.';
      await this.notifications.notify({
        recipientId: target.authorId,
        type: NotificationType.SUPPORT_TICKET_REPLIED,
        postId: target.postId ?? undefined,
        ticketId: id,
        note,
      });
    }

    return this.getOne(id);
  }

  /**
   * Claims an active ticket for the caller. `force` takes it over from
   * another admin; without it, a ticket someone else holds answers 409.
   */
  async claim(
    id: string,
    adminId: string,
    dto: ClaimSupportTicketDto,
  ): Promise<AdminSupportTicketDetailDto> {
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (!isTicketActive(ticket.status)) {
        throw new StateConflictException(
          'TICKET_ALREADY_CLOSED',
          'This support ticket is already closed',
        );
      }
      if (ticket.assigneeId === adminId) return;
      if (isClaimedByOther(ticket, adminId) && dto.force !== true) {
        throw claimedByOtherError();
      }
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          { $set: { assigneeId: adminId, assignedAt: new Date() } },
          { session },
        )
        .exec();
    });
    return this.getOne(id);
  }

  /** Hands a ticket the caller holds back to the shared queue. */
  async release(
    id: string,
    adminId: string,
  ): Promise<AdminSupportTicketDetailDto> {
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (ticket.assigneeId === null) {
        throw new StateConflictException(
          'TICKET_NOT_CLAIMED',
          'Nobody has claimed this ticket',
        );
      }
      if (isClaimedByOther(ticket, adminId)) throw claimedByOtherError();
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          { $set: { assigneeId: null, assignedAt: null } },
          { session },
        )
        .exec();
    });
    return this.getOne(id);
  }

  async resolve(
    id: string,
    adminId: string,
    dto: ResolveSupportTicketDto,
  ): Promise<AdminSupportTicketDetailDto> {
    const preview = await this.tickets
      .findOne({ _id: id })
      .select('category appeal.postId')
      .exec();
    if (!preview) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
    }

    const isAppeal = preview.category === SupportTicketCategory.CONTENT_APPEAL;
    const trimmedNote = dto.note?.trim() || null;

    if (isAppeal) {
      if (dto.decision !== 'APPROVE' && dto.decision !== 'REJECT') {
        throw new InvalidInputException(
          'INVALID_TICKET_DECISION',
          'CONTENT_APPEAL tickets must be resolved with APPROVE or REJECT',
        );
      }
      if (
        dto.decision === 'REJECT' &&
        (!trimmedNote || trimmedNote.length < MIN_REJECT_NOTE_LENGTH)
      ) {
        throw new InvalidInputException(
          'RESOLUTION_NOTE_REQUIRED',
          `Please provide a reason of at least ${MIN_REJECT_NOTE_LENGTH} characters when rejecting an appeal`,
        );
      }
      return this.resolveContentAppeal(
        id,
        preview.appeal?.postId ?? '',
        adminId,
        dto.decision,
        trimmedNote,
      );
    }

    if (dto.decision !== 'RESOLVE' && dto.decision !== 'CLOSE') {
      throw new InvalidInputException(
        'INVALID_TICKET_DECISION',
        'Support tickets must be resolved with RESOLVE or CLOSE',
      );
    }
    if (
      dto.decision === 'CLOSE' &&
      (!trimmedNote || trimmedNote.length < MIN_REJECT_NOTE_LENGTH)
    ) {
      throw new InvalidInputException(
        'RESOLUTION_NOTE_REQUIRED',
        `Please provide a reason of at least ${MIN_REJECT_NOTE_LENGTH} characters when closing a ticket`,
      );
    }
    return this.resolveGeneralTicket(id, adminId, dto.decision, trimmedNote);
  }

  private async resolveContentAppeal(
    id: string,
    postId: string,
    adminId: string,
    decision: 'APPROVE' | 'REJECT',
    trimmedNote: string | null,
  ): Promise<AdminSupportTicketDetailDto> {
    let shouldSchedulePublished = false;
    let notifyAuthorId = '';

    await this.mongo.withTransaction(async (session) => {
      if (postId) await lockDocument(this.mongo, session, 'post', postId);
      await lockDocument(this.mongo, session, 'ticket', id);

      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (!isTicketActive(ticket.status)) {
        throw new StateConflictException(
          'TICKET_ALREADY_CLOSED',
          'This support ticket is already closed',
        );
      }
      if (isClaimedByOther(ticket, adminId)) throw claimedByOtherError();

      const now = new Date();
      notifyAuthorId = ticket.authorId;

      if (decision === 'APPROVE') {
        const post = await this.posts
          .findOne({ _id: postId })
          .session(session)
          .exec();
        if (!post) {
          throw new StateConflictException(
            'POST_UNAVAILABLE',
            'The appealed post no longer exists',
          );
        }

        if (post.status === PostStatus.REJECTED) {
          await this.posts
            .updateOne(
              { _id: postId },
              {
                $set: {
                  status: PostStatus.PUBLISHED,
                  publishedAt: post.publishedAt ?? now,
                  'moderation.reviewedById': adminId,
                  'moderation.reviewedAt': now,
                  'moderation.reviewNote': trimmedNote,
                  searchIndexedAt: null,
                },
              },
              { session },
            )
            .exec();
          shouldSchedulePublished = true;
        } else if (post.status === PostStatus.REMOVED) {
          const restoredStatus =
            post.removal?.previousStatus === PostStatus.DRAFT
              ? PostStatus.DRAFT
              : PostStatus.PUBLISHED;
          await this.posts
            .updateOne(
              { _id: postId },
              {
                $set: {
                  status: restoredStatus,
                  publishedAt:
                    restoredStatus === PostStatus.PUBLISHED
                      ? (post.publishedAt ?? now)
                      : post.publishedAt,
                  'removal.restoredById': adminId,
                  'removal.restoredAt': now,
                  searchIndexedAt: null,
                },
              },
              { session },
            )
            .exec();
          shouldSchedulePublished = restoredStatus === PostStatus.PUBLISHED;
        }

        await this.tickets
          .updateOne(
            { _id: ticket.id },
            {
              $set: {
                status: SupportTicketStatus.RESOLVED,
                'appeal.outcome': AppealOutcome.APPROVED,
                waitingUserSince: null,
                waitingReminderCount: 0,
                lastReminderAt: null,
                resolvedById: adminId,
                assigneeId: adminId,
                assignedAt: ticket.assignedAt ?? now,
                resolvedAt: now,
                resolutionNote: trimmedNote,
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
              senderId: adminId,
              senderRole: SupportSenderRole.ADMIN,
              kind: SupportMessageKind.DECISION_APPROVED,
              isInternal: false,
              body:
                trimmedNote ??
                'Kháng cáo được chấp thuận. Bài viết đã được khôi phục.',
            },
          ],
          { session },
        );
        return;
      }

      // REJECT: intentionally keep post.moderation.reviewedAt unchanged so the
      // incidentKey and 14-day appeal window remain deterministic.
      await this.tickets
        .updateOne(
          { _id: ticket.id },
          {
            $set: {
              status: SupportTicketStatus.RESOLVED,
              'appeal.outcome': AppealOutcome.REJECTED,
              waitingUserSince: null,
              waitingReminderCount: 0,
              lastReminderAt: null,
              resolvedById: adminId,
              assigneeId: adminId,
              assignedAt: ticket.assignedAt ?? now,
              resolvedAt: now,
              resolutionNote: trimmedNote,
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
            senderId: adminId,
            senderRole: SupportSenderRole.ADMIN,
            kind: SupportMessageKind.DECISION_REJECTED,
            isInternal: false,
            body: trimmedNote ?? 'Kháng cáo bị từ chối.',
          },
        ],
        { session },
      );
    });

    if (shouldSchedulePublished) {
      this.searchIndex.schedule();
      this.captions.schedule();
    }

    if (notifyAuthorId) {
      await this.notifications.notify({
        recipientId: notifyAuthorId,
        type: NotificationType.SUPPORT_TICKET_RESOLVED,
        postId,
        ticketId: id,
        reason: decision === 'APPROVE' ? 'APPEAL_APPROVED' : 'APPEAL_REJECTED',
        note: trimmedNote ?? undefined,
      });
    }

    return this.getOne(id);
  }

  private async resolveGeneralTicket(
    id: string,
    adminId: string,
    decision: 'RESOLVE' | 'CLOSE',
    trimmedNote: string | null,
  ): Promise<AdminSupportTicketDetailDto> {
    let notifyAuthorId = '';

    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'ticket', id);
      const ticket = await this.tickets
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!ticket) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Ticket not found');
      }
      if (!isTicketActive(ticket.status)) {
        throw new StateConflictException(
          'TICKET_ALREADY_CLOSED',
          'This support ticket is already closed',
        );
      }
      if (isClaimedByOther(ticket, adminId)) throw claimedByOtherError();

      const now = new Date();
      notifyAuthorId = ticket.authorId;
      const nextStatus =
        decision === 'RESOLVE'
          ? SupportTicketStatus.RESOLVED
          : SupportTicketStatus.CLOSED;
      const kind =
        decision === 'RESOLVE'
          ? SupportMessageKind.RESOLVED
          : SupportMessageKind.CLOSED;
      const fallbackBody =
        decision === 'RESOLVE'
          ? 'Yêu cầu hỗ trợ đã được giải quyết.'
          : 'Yêu cầu hỗ trợ đã được đóng.';

      await this.tickets
        .updateOne(
          { _id: ticket.id },
          {
            $set: {
              status: nextStatus,
              waitingUserSince: null,
              waitingReminderCount: 0,
              lastReminderAt: null,
              resolvedById: adminId,
              assigneeId: adminId,
              assignedAt: ticket.assignedAt ?? now,
              resolvedAt: now,
              resolutionNote: trimmedNote,
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
            senderId: adminId,
            senderRole: SupportSenderRole.ADMIN,
            kind,
            isInternal: false,
            body: trimmedNote ?? fallbackBody,
          },
        ],
        { session },
      );
    });

    if (notifyAuthorId) {
      await this.notifications.notify({
        recipientId: notifyAuthorId,
        type:
          decision === 'RESOLVE'
            ? NotificationType.SUPPORT_TICKET_RESOLVED
            : NotificationType.SUPPORT_TICKET_CLOSED,
        ticketId: id,
        note: trimmedNote ?? undefined,
      });
    }

    return this.getOne(id);
  }

  private async statusCounts(
    category?: SupportTicketCategory,
  ): Promise<AdminSupportStatusCountsDto> {
    const pipeline = [
      ...(category ? [{ $match: { category } }] : []),
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ];
    const grouped = await this.tickets
      .aggregate<{ _id: SupportTicketStatus; count: number }>(pipeline)
      .exec();

    const byStatus = new Map<SupportTicketStatus, number>(
      grouped.map((entry) => [entry._id, entry.count]),
    );
    const open = byStatus.get(SupportTicketStatus.OPEN) ?? 0;
    const waitingUser = byStatus.get(SupportTicketStatus.WAITING_USER) ?? 0;
    const resolved = byStatus.get(SupportTicketStatus.RESOLVED) ?? 0;
    const closed = byStatus.get(SupportTicketStatus.CLOSED) ?? 0;
    const withdrawn = byStatus.get(SupportTicketStatus.WITHDRAWN) ?? 0;
    const expired = byStatus.get(SupportTicketStatus.EXPIRED) ?? 0;
    return {
      open,
      waitingUser,
      resolved,
      closed,
      withdrawn,
      expired,
      total: open + waitingUser + resolved + closed + withdrawn + expired,
    };
  }

  private async categoryCounts(): Promise<AdminSupportCategoryCountsDto> {
    const grouped = await this.tickets
      .aggregate<{ _id: SupportTicketCategory; count: number }>([
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ])
      .exec();

    const byCat = new Map<SupportTicketCategory, number>(
      grouped.map((entry) => [entry._id, entry.count]),
    );
    return {
      contentAppeal: byCat.get(SupportTicketCategory.CONTENT_APPEAL) ?? 0,
      paymentIssue: byCat.get(SupportTicketCategory.PAYMENT_ISSUE) ?? 0,
      verification: byCat.get(SupportTicketCategory.VERIFICATION) ?? 0,
      general: byCat.get(SupportTicketCategory.GENERAL) ?? 0,
    };
  }

  private async hydrateListItems(
    rows: readonly SupportTicket[],
  ): Promise<AdminSupportTicketListItemDto[]> {
    if (rows.length === 0) return [];
    const userIdSet = new Set<string>();
    for (const row of rows) {
      userIdSet.add(row.authorId);
      if (row.resolvedById) userIdSet.add(row.resolvedById);
      if (row.assigneeId) userIdSet.add(row.assigneeId);
    }
    const userIds = [...userIdSet];
    const users = await this.users.find({ _id: { $in: userIds } }).exec();
    const byId = new Map(users.map((user) => [user.id, user]));

    const items: AdminSupportTicketListItemDto[] = [];
    for (const row of rows) {
      const author = byId.get(row.authorId);
      if (!author) continue;
      const resolver = row.resolvedById
        ? (byId.get(row.resolvedById) ?? null)
        : null;
      const assignee = row.assigneeId
        ? (byId.get(row.assigneeId) ?? null)
        : null;
      items.push({
        ...toTicketListItem(row),
        author: toAuthorSummary(author),
        resolvedBy: resolver ? toAuthorSummary(resolver) : null,
        assignee: assignee ? toAuthorSummary(assignee) : null,
        assignedAt: row.assignedAt,
      });
    }
    return items;
  }

  private async loadAdminPost(postId: string): Promise<AdminPostDto | null> {
    try {
      return await this.adminPosts.findOne(postId);
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }
}
