import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { filter, Observable, Subject } from 'rxjs';
import { ModerationSettingsService } from '../moderation/moderation-settings.service.js';
import {
  afterCursor,
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination/index.js';
import {
  Notification,
  NotificationType,
  Post,
  PostType,
  User,
} from '../mongo/models.js';
import {
  NotificationDto,
  NotificationPageDto,
  UnreadCountDto,
} from './dto/notification.dto.js';

type NotificationRow = {
  notification: Notification;
  actor: User | null;
  postType: PostType | null;
  reasonText: string | null;
};

export interface NotifyInput {
  recipientId: string;
  actorId?: string;
  type: NotificationType;
  postId?: string;
  commentId?: string;
  reason?: string;
  note?: string;
}

const TOGGLED_TYPES: readonly NotificationType[] = [
  NotificationType.LIKE,
  NotificationType.REPOST,
  NotificationType.FOLLOW,
];

function toDto({
  notification,
  actor,
  postType,
  reasonText,
}: NotificationRow): NotificationDto {
  return {
    id: notification.id,
    type: notification.type,
    actor: actor
      ? {
          id: actor.id,
          username: actor.username,
          fullName: actor.fullName,
          avatarUrl: actor.avatarUrl,
        }
      : null,
    postId: notification.postId,
    postType,
    commentId: notification.commentId,
    reason: notification.reason,
    reasonText,
    note: notification.note,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly events = new Subject<NotificationRow>();

  constructor(
    @InjectModel(Notification.name)
    private readonly notifications: Model<Notification>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    private readonly moderationSettings: ModerationSettingsService,
  ) {}

  stream(userId: string): Observable<NotificationDto> {
    return new Observable<NotificationDto>((subscriber) => {
      const subscription = this.events
        .pipe(filter((row) => row.notification.recipientId === userId))
        .subscribe((row) => subscriber.next(toDto(row)));
      return () => subscription.unsubscribe();
    });
  }

  async notify(input: NotifyInput): Promise<void> {
    if (input.recipientId === input.actorId) return;
    try {
      if (TOGGLED_TYPES.includes(input.type)) {
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
      const created = await this.notifications.create({
        ...input,
        actorId: input.actorId ?? null,
      });
      const actor = input.actorId
        ? await this.users.findById(input.actorId).exec()
        : null;
      if (input.actorId && !actor) return;
      const [postType] = await this.postTypes([created.postId]);
      const texts = await this.moderationSettings.reasonTexts();
      this.events.next({
        notification: created,
        actor,
        postType: postType ?? null,
        reasonText: created.reason ? (texts.get(created.reason) ?? null) : null,
      });
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
    const actorIds = rows.flatMap(({ actorId }) => (actorId ? [actorId] : []));
    const actors = await this.users.find({ _id: { $in: actorIds } }).exec();
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    const types = await this.postTypeById(rows.map(({ postId }) => postId));
    const texts = await this.moderationSettings.reasonTexts();
    const reasonTextOf = (reason: string | null) =>
      reason ? (texts.get(reason) ?? null) : null;
    return {
      ...page,
      items: page.items.flatMap((notification) => {
        const postType = notification.postId
          ? (types.get(notification.postId) ?? null)
          : null;
        if (!notification.actorId) {
          return [
            toDto({
              notification,
              actor: null,
              postType,
              reasonText: reasonTextOf(notification.reason),
            }),
          ];
        }
        const actor = byId.get(notification.actorId);
        return actor
          ? [
              toDto({
                notification,
                actor,
                postType,
                reasonText: reasonTextOf(notification.reason),
              }),
            ]
          : [];
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

  private async postTypeById(
    ids: (string | null)[],
  ): Promise<Map<string, PostType>> {
    const postIds = ids.flatMap((id) => (id ? [id] : []));
    if (postIds.length === 0) return new Map();
    const posts = await this.posts
      .find({ _id: { $in: postIds } })
      .select('type')
      .exec();
    return new Map(posts.map((post) => [post.id, post.type]));
  }

  private async postTypes(
    ids: (string | null)[],
  ): Promise<(PostType | null)[]> {
    const types = await this.postTypeById(ids);
    return ids.map((id) => (id ? (types.get(id) ?? null) : null));
  }
}
