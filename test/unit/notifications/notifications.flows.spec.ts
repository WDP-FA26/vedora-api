import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ModerationSettingsService } from '@src/moderation/moderation-settings.service.js';
import {
  type Notification,
  NotificationType,
  type User,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { NotificationsService } from '@src/notifications/notifications.service.js';
import { createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

describe('Notifications flows', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: NotificationsService;
  let recipient: User;
  let actor: User;
  let otherActor: User;

  const notifications = () => db.connection.model<Notification>('Notification');
  const countFor = (recipientId: string) =>
    notifications().countDocuments({ recipientId }).exec();
  const page = (userId: string, limit: number, cursor?: string) =>
    service.list(userId, { limit, cursor });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('notifflows'))],
      providers: [
        NotificationsService,
        ModerationSettingsService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(NotificationsService);
    recipient = await createUser(db, { username: 'flows.recipient' });
    actor = await createUser(db, { username: 'flows.actor' });
    otherActor = await createUser(db, { username: 'flows.other' });
  });
  beforeEach(async () => {
    await notifications().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('fan-out', () => {
    it('creates one LIKE notification when the same like arrives twice at once', async () => {
      const postId = randomUUID();
      const like = {
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId,
      };

      await Promise.all([service.notify(like), service.notify(like)]);

      expect(await countFor(recipient.id)).toBe(1);
    });

    it('creates one FOLLOW notification when follow is toggled concurrently', async () => {
      const follow = {
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.FOLLOW,
      };

      await Promise.all([
        service.notify(follow),
        service.notify(follow),
        service.notify(follow),
      ]);

      expect(await countFor(recipient.id)).toBe(1);
    });

    it('keeps a like notification per post', async () => {
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId: randomUUID(),
      });
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId: randomUUID(),
      });

      expect(await countFor(recipient.id)).toBe(2);
    });

    it('keeps a like notification per actor on the same post', async () => {
      const postId = randomUUID();

      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId,
      });
      await service.notify({
        recipientId: recipient.id,
        actorId: otherActor.id,
        type: NotificationType.LIKE,
        postId,
      });

      expect(await countFor(recipient.id)).toBe(2);
    });

    it('treats a like and a repost of the same post as separate notifications', async () => {
      const postId = randomUUID();

      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId,
      });
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.REPOST,
        postId,
      });

      expect(await countFor(recipient.id)).toBe(2);
    });

    it('ignores a self-follow', async () => {
      await service.notify({
        recipientId: actor.id,
        actorId: actor.id,
        type: NotificationType.FOLLOW,
      });

      expect(await countFor(actor.id)).toBe(0);
    });

    it('stores a system notification without an actor', async () => {
      await service.notify({
        recipientId: recipient.id,
        type: NotificationType.POST_APPROVED,
        postId: randomUUID(),
      });

      const { items } = await page(recipient.id, 20);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: NotificationType.POST_APPROVED,
        actor: null,
        readAt: null,
      });
    });

    it('pushes nothing to the stream for an actor that no longer exists', async () => {
      const received: unknown[] = [];
      const subscription = service
        .stream(recipient.id)
        .subscribe((event) => received.push(event));

      await service.notify({
        recipientId: recipient.id,
        actorId: randomUUID(),
        type: NotificationType.FOLLOW,
      });
      subscription.unsubscribe();

      expect(received).toEqual([]);
    });

    it('counts as unread only notifications the list can show', async () => {
      await service.notify({
        recipientId: recipient.id,
        actorId: randomUUID(),
        type: NotificationType.FOLLOW,
      });

      const { items } = await page(recipient.id, 20);
      const { unreadCount } = await service.unreadCount(recipient.id);

      expect(unreadCount).toBe(items.length);
    });
  });

  describe('listing', () => {
    const seed = async (count: number, createdAt: Date) => {
      const rows: Partial<Notification>[] = [];
      for (let index = 0; index < count; index += 1) {
        rows.push({
          _id: randomUUID(),
          recipientId: recipient.id,
          actorId: actor.id,
          type: NotificationType.COMMENT,
          postId: randomUUID(),
          createdAt,
        });
      }
      await notifications().insertMany(rows);
    };

    it('pages notifications with the same timestamp without overlap or gaps', async () => {
      await seed(7, new Date('2026-11-01T00:00:00Z'));
      const seen: string[] = [];

      let cursor: string | undefined;
      do {
        const result = await page(recipient.id, 3, cursor);
        for (const item of result.items) seen.push(item.id);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });

    it('returns no next cursor when the last page is exactly full', async () => {
      await seed(4, new Date('2026-11-01T00:00:00Z'));

      const first = await page(recipient.id, 2);
      const second = await page(recipient.id, 2, first.nextCursor ?? undefined);

      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it('lists newest first', async () => {
      await seed(1, new Date('2026-10-01T00:00:00Z'));
      await seed(1, new Date('2026-11-01T00:00:00Z'));

      const { items } = await page(recipient.id, 20);

      expect(items.map((item) => item.createdAt.toISOString())).toEqual([
        '2026-11-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
      ]);
    });

    it('never lists another user’s notifications', async () => {
      await seed(2, new Date());

      const { items } = await page(actor.id, 20);

      expect(items).toEqual([]);
    });

    it('does not page into another user’s notifications through their cursor', async () => {
      await seed(3, new Date('2026-11-01T00:00:00Z'));
      const [foreign] = await notifications()
        .find({ recipientId: recipient.id })
        .exec();
      await notifications().create({
        recipientId: actor.id,
        actorId: recipient.id,
        type: NotificationType.FOLLOW,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      });

      const { items } = await page(actor.id, 20, foreign.id);

      for (const item of items) {
        expect(item.actor?.id).toBe(recipient.id);
      }
    });
  });

  describe('read state', () => {
    const notifyFollow = async (to: User, from: User) => {
      await service.notify({
        recipientId: to.id,
        actorId: from.id,
        type: NotificationType.FOLLOW,
      });
      const row = await notifications()
        .findOne({ recipientId: to.id, actorId: from.id })
        .exec();
      if (!row) throw new Error('notification not stored');
      return row;
    };

    it('marks one notification read and lowers the unread count by one', async () => {
      const first = await notifyFollow(recipient, actor);
      await notifyFollow(recipient, otherActor);

      await service.markRead(recipient.id, first.id);

      expect(await service.unreadCount(recipient.id)).toEqual({
        unreadCount: 1,
      });
    });

    it('keeps the first read time when marked read twice', async () => {
      const row = await notifyFollow(recipient, actor);
      await service.markRead(recipient.id, row.id);
      const firstRead = (await notifications().findById(row.id).exec())?.readAt;

      await new Promise((settle) => setTimeout(settle, 10));
      await service.markRead(recipient.id, row.id);

      const readAt = (await notifications().findById(row.id).exec())?.readAt;
      expect(readAt?.getTime()).toBe(firstRead?.getTime());
    });

    it('ignores an attempt to mark someone else’s notification read', async () => {
      const row = await notifyFollow(recipient, actor);

      await service.markRead(actor.id, row.id);

      expect(
        (await notifications().findById(row.id).exec())?.readAt,
      ).toBeNull();
    });

    it('marks all of the caller’s notifications read without touching others', async () => {
      await notifyFollow(recipient, actor);
      await notifyFollow(recipient, otherActor);
      await notifyFollow(actor, recipient);

      await service.markAllRead(recipient.id);

      expect(await service.unreadCount(recipient.id)).toEqual({
        unreadCount: 0,
      });
      expect(await service.unreadCount(actor.id)).toEqual({ unreadCount: 1 });
    });
  });
});
