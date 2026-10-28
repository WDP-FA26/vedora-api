import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import type { Notification, User } from '../mongo/models';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { createUser } from '../../test/fixtures';
import { NotificationType } from '../mongo/models';
import { NotificationsService } from './notifications.service';

const postId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';

describe('NotificationsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: NotificationsService;
  let recipient: User;
  let actor: User;

  const stored = () => db.db.collection('notifications').find({}).toArray();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('notifications'))],
      providers: [
        NotificationsService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(NotificationsService);
    recipient = await createUser(db, { username: 'recipient' });
    actor = await createUser(db, { username: 'actor', fullName: 'A' });
  });
  beforeEach(async () => {
    await db.db.collection('notifications').deleteMany({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('stores a notification and pushes it only to its recipient', async () => {
    const mine: unknown[] = [];
    const others: unknown[] = [];
    service.stream(recipient.id).subscribe((n) => mine.push(n));
    service.stream(actor.id).subscribe((n) => others.push(n));

    await service.notify({
      recipientId: recipient.id,
      actorId: actor.id,
      type: NotificationType.LIKE,
      postId,
    });

    expect(await stored()).toHaveLength(1);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: 'LIKE',
      actor: { id: actor.id, username: 'actor' },
    });
    expect(mine[0]).not.toHaveProperty('recipientId');
    expect(others).toHaveLength(0);
  });

  it('ignores self-notifications and repeated likes', async () => {
    await service.notify({
      recipientId: recipient.id,
      actorId: recipient.id,
      type: NotificationType.LIKE,
      postId,
    });
    for (let repeat = 0; repeat < 2; repeat++) {
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.LIKE,
        postId,
      });
    }
    expect(await stored()).toHaveLength(1);
  });

  it('keeps every comment', async () => {
    for (let comment = 0; comment < 2; comment++) {
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.COMMENT,
        postId,
        commentId: crypto.randomUUID(),
      });
    }
    expect(await stored()).toHaveLength(2);
  });

  it('never throws when storing fails', async () => {
    const notifications = app.get<Model<Notification>>(
      getModelToken('Notification'),
    );
    vi.spyOn(notifications, 'create').mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.FOLLOW,
      }),
    ).resolves.toBeUndefined();
    expect(await stored()).toHaveLength(0);
  });

  it('pages newest first and counts unread', async () => {
    for (let index = 0; index < 3; index++) {
      await service.notify({
        recipientId: recipient.id,
        actorId: actor.id,
        type: NotificationType.COMMENT,
        postId,
        commentId: crypto.randomUUID(),
      });
    }
    expect((await service.unreadCount(recipient.id)).unreadCount).toBe(3);
    const first = await service.list(recipient.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await service.list(recipient.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map(({ id }) => id);
    expect(new Set(ids).size).toBe(3);
  });

  it('marks only the caller’s unread notifications as read', async () => {
    await service.notify({
      recipientId: recipient.id,
      actorId: actor.id,
      type: NotificationType.FOLLOW,
    });
    const [row] = await stored();
    await service.markRead(actor.id, String(row._id));
    expect((await service.unreadCount(recipient.id)).unreadCount).toBe(1);
    await service.markRead(recipient.id, String(row._id));
    expect((await service.unreadCount(recipient.id)).unreadCount).toBe(0);
  });
});
