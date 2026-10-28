import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { filter, Observable, Subject } from 'rxjs';
import {
  afterCursor,
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination/index.js';
import { Notification, NotificationType, User } from '../mongo/models.js';
import {
  NotificationDto,
  NotificationPageDto,
  UnreadCountDto,
} from './dto/notification.dto.js';

type NotificationRow = { notification: Notification; actor: User };

export interface NotifyInput {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string;
  commentId?: string;
}

function toDto({ notification, actor }: NotificationRow): NotificationDto {
  return {
    id: notification.id,
    type: notification.type,
    actor: {
      id: actor.id,
      username: actor.username,
      fullName: actor.fullName,
      avatarUrl: actor.avatarUrl,
    },
    postId: notification.postId,
    commentId: notification.commentId,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  // Live fan-out lives in this process. Running several API instances needs a
  // shared bus (e.g. Postgres LISTEN/NOTIFY or Redis) in place of this Subject.
  private readonly events = new Subject<NotificationRow>();

  constructor(
    @InjectModel(Notification.name)
    private readonly notifications: Model<Notification>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /** Live notifications for one user; one subscription per open connection. */
  stream(userId: string): Observable<NotificationDto> {
    return new Observable<NotificationDto>((subscriber) => {
      const subscription = this.events
        .pipe(filter((row) => row.notification.recipientId === userId))
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
        const existing = await this.notifications
          .findOne({
            recipientId: input.recipientId,
            actorId: input.actorId,
            type: input.type,
            postId: input.postId ?? null,
          })
          .select('_id')
          .exec();
        if (existing) return;
      }
      const created = await this.notifications.create(input);
      const actor = await this.users.findById(input.actorId).exec();
      if (actor) this.events.next({ notification: created, actor });
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
    const filter: QueryFilter<Notification> = { recipientId: userId };
    if (query.cursor) {
      const cursor = await this.notifications
        .findById(query.cursor)
        .select('createdAt')
        .exec();
      if (!cursor) return { items: [], nextCursor: null };
      Object.assign(
        filter,
        afterCursor<Notification>('createdAt', {
          value: cursor.createdAt,
          id: cursor.id,
        }),
      );
    }
    const rows = await this.notifications
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const page = createCursorPaginatedResponse(rows, query.limit);
    const actors = await this.users
      .find({ _id: { $in: rows.map((row) => row.actorId) } })
      .exec();
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    return {
      ...page,
      items: page.items.flatMap((notification) => {
        const actor = byId.get(notification.actorId);
        return actor ? [toDto({ notification, actor })] : [];
      }),
    };
  }

  async unreadCount(userId: string): Promise<UnreadCountDto> {
    const unreadCount = await this.notifications
      .countDocuments({ recipientId: userId, readAt: null })
      .exec();
    return { unreadCount };
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.notifications
      .updateOne(
        { _id: id, recipientId: userId, readAt: null },
        { $set: { readAt: new Date() } },
      )
      .exec();
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notifications
      .updateMany(
        { recipientId: userId, readAt: null },
        { $set: { readAt: new Date() } },
      )
      .exec();
  }
}
