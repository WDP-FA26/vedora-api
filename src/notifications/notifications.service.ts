import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { filter, Observable, Subject } from 'rxjs';
import {
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationDto,
  NotificationPageDto,
  UnreadCountDto,
} from './dto/notification.dto';

const notificationSelect = {
  id: true,
  recipientId: true,
  type: true,
  postId: true,
  commentId: true,
  readAt: true,
  createdAt: true,
  actor: {
    select: { id: true, username: true, fullName: true, avatarUrl: true },
  },
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;

export interface NotifyInput {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string;
  commentId?: string;
}

function toDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor,
    postId: row.postId,
    commentId: row.commentId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  // Live fan-out lives in this process. Running several API instances needs a
  // shared bus (e.g. Postgres LISTEN/NOTIFY or Redis) in place of this Subject.
  private readonly events = new Subject<NotificationRow>();

  constructor(private readonly prisma: PrismaService) {}

  /** Live notifications for one user; one subscription per open connection. */
  stream(userId: string): Observable<NotificationDto> {
    return new Observable<NotificationDto>((subscriber) => {
      const subscription = this.events
        .pipe(filter((row) => row.recipientId === userId))
        .subscribe((row) => subscriber.next(toDto(row)));
      return () => subscription.unsubscribe();
    });
  }

  /**
   * Records and pushes a notification. Never throws: a failed notification
   * must not fail the like, comment or follow that caused it.
   */
  async notify(input: NotifyInput): Promise<void> {
    if (input.recipientId === input.actorId) return;
    try {
      if (input.type !== NotificationType.COMMENT) {
        // Toggling a like or follow on and off must not spam the recipient.
        const existing = await this.prisma.notification.findFirst({
          where: {
            recipientId: input.recipientId,
            actorId: input.actorId,
            type: input.type,
            postId: input.postId ?? null,
          },
          select: { id: true },
        });
        if (existing) return;
      }
      const row = await this.prisma.notification.create({
        data: input,
        select: notificationSelect,
      });
      this.events.next(row);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not create ${input.type} notification: ${String(error)}`,
      );
    }
  }

  async list(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<NotificationPageDto> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: notificationSelect,
    });
    const page = createCursorPaginatedResponse(rows, query.limit);
    return { ...page, items: page.items.map(toDto) };
  }

  async unreadCount(userId: string): Promise<UnreadCountDto> {
    const unreadCount = await this.prisma.notification.count({
      where: { recipientId: userId, readAt: null },
    });
    return { unreadCount };
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
