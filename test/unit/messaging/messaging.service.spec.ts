import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { MessagingInbox } from '../../../src/messaging/dto/messaging.dto.js';
import { MessagingEventsService } from '../../../src/messaging/messaging-events.service.js';
import { MessagingService } from '../../../src/messaging/messaging.service.js';
import {
  AccountStatus,
  Conversation,
  DirectMessage,
  Follow,
  MessagingEvent,
  MessagingEventType,
  type User,
  UserRole,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('MessagingService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: MessagingService;
  let alice: User;
  let bob: User;
  let carol: User;
  let admin: User;

  const users = () => db.connection.model<User>('User');
  const follows = () => db.connection.model<Follow>(Follow.name);
  const conversations = () =>
    db.connection.model<Conversation>(Conversation.name);
  const messages = () => db.connection.model<DirectMessage>(DirectMessage.name);
  const events = () =>
    db.connection.model<MessagingEvent>(MessagingEvent.name);

  const follow = (follower: User, following: User) =>
    follows().create({ followerId: follower.id, followingId: following.id });

  const unfollow = (follower: User, following: User) =>
    follows().deleteOne({ followerId: follower.id, followingId: following.id });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('messaging_unit'))],
      providers: [MessagingEventsService, MessagingService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(MessagingService);
  });

  beforeEach(async () => {
    await Promise.all([
      users().deleteMany({}),
      follows().deleteMany({}),
      conversations().deleteMany({}),
      messages().deleteMany({}),
      events().deleteMany({}),
    ]);
    [alice, bob, carol, admin] = await Promise.all([
      createUser(db, { username: 'msg.alice', fullName: 'Alice' }),
      createUser(db, { username: 'msg.bob', fullName: 'Bob' }),
      createUser(db, { username: 'msg.carol', fullName: 'Carol' }),
      createUser(db, {
        username: 'msg.admin',
        fullName: 'Admin',
        role: UserRole.ADMIN,
      }),
    ]);
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  describe('contact', () => {
    it('rejects self-contact', async () => {
      await expect(service.contact(alice.id, alice.id)).rejects.toMatchObject({
        code: 'SELF_MESSAGE_NOT_ALLOWED',
      });
    });

    it('rejects missing or non-ACTIVE peers', async () => {
      await expect(
        service.contact(alice.id, randomUUID()),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await users().updateOne(
        { _id: bob.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );
      await expect(service.contact(alice.id, bob.id)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('resolves follow permissions, box, and existing conversationId', async () => {
      const initial = await service.contact(alice.id, bob.id);
      expect(initial).toMatchObject({
        peer: { id: bob.id, username: 'msg.bob' },
        conversationId: null,
        box: MessagingInbox.REQUESTS,
        followsPeer: false,
        peerFollowsYou: false,
        canSend: false,
      });

      await follow(alice, bob);
      const outgoing = await service.contact(alice.id, bob.id);
      expect(outgoing).toMatchObject({
        box: MessagingInbox.REQUESTS,
        followsPeer: true,
        peerFollowsYou: false,
        canSend: true,
      });

      const sent = await service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: 'Hi Bob',
      });
      await follow(bob, alice);

      const mutual = await service.contact(alice.id, bob.id);
      expect(mutual).toMatchObject({
        conversationId: sent.conversationId,
        box: MessagingInbox.FRIENDS,
        followsPeer: true,
        peerFollowsYou: true,
        canSend: true,
      });
    });
  });

  describe('sendToUser & sendToConversation', () => {
    it('rejects self-messages, missing/suspended senders, inactive recipients, and unfollowed peers', async () => {
      const dto = { clientMessageId: randomUUID(), body: 'Hello' };

      await expect(
        service.sendToUser(alice.id, alice.id, dto),
      ).rejects.toBeInstanceOf(InvalidInputException);

      await expect(
        service.sendToUser(randomUUID(), bob.id, dto),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await users().updateOne(
        { _id: alice.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );
      await expect(
        service.sendToUser(alice.id, bob.id, dto),
      ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
      await users().updateOne(
        { _id: alice.id },
        { $set: { status: AccountStatus.ACTIVE } },
      );

      await users().updateOne(
        { _id: bob.id },
        { $set: { status: AccountStatus.PENDING_EMAIL } },
      );
      await expect(
        service.sendToUser(alice.id, bob.id, dto),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await users().updateOne(
        { _id: bob.id },
        { $set: { status: AccountStatus.ACTIVE } },
      );

      await expect(
        service.sendToUser(alice.id, bob.id, dto),
      ).rejects.toBeInstanceOf(AccessDeniedException);
      expect(await conversations().countDocuments()).toBe(0);
    });

    it('creates one conversation per pair, increments sequence, handles idempotency/conflict, and records outbox events', async () => {
      await follow(alice, bob);
      await follow(bob, alice);
      const clientMessageId = randomUUID();

      const first = await service.sendToUser(alice.id, bob.id, {
        clientMessageId,
        body: 'First message',
      });
      expect(first.message).toMatchObject({
        senderId: alice.id,
        recipientId: bob.id,
        sequence: 1,
        body: 'First message',
      });

      // Same clientMessageId + same body is idempotent.
      const retry = await service.sendToUser(alice.id, bob.id, {
        clientMessageId,
        body: 'First message',
      });
      expect(retry.message.id).toBe(first.message.id);
      expect(retry.message.sequence).toBe(1);
      expect(await events().countDocuments()).toBe(1);

      // Same clientMessageId + different body throws 409 MESSAGE_ID_CONFLICT.
      await expect(
        service.sendToUser(alice.id, bob.id, {
          clientMessageId,
          body: 'Edited text',
        }),
      ).rejects.toBeInstanceOf(StateConflictException);

      // Mismatched expectedConversationId throws NOT_FOUND.
      await expect(
        service.sendToUser(
          alice.id,
          bob.id,
          { clientMessageId: randomUUID(), body: 'Next' },
          randomUUID(),
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      // Reply via sendToConversation increments sequence to 2.
      const reply = await service.sendToConversation(
        bob.id,
        first.conversationId,
        { clientMessageId: randomUUID(), body: 'Reply' },
      );
      expect(reply.message.sequence).toBe(2);

      // Non-participant (including admin) cannot send to conversation.
      await expect(
        service.sendToConversation(admin.id, first.conversationId, {
          clientMessageId: randomUUID(),
          body: 'Snooping',
        }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('listConversations, getConversation & listMessages', () => {
    it('separates friends and requests inboxes, computes requestDirection/unreadCount, and paginates cursors', async () => {
      await follow(alice, bob);
      await follow(bob, alice);
      await follow(alice, carol);

      const ab = await service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: 'Friend msg 1',
      });
      await service.sendToUser(bob.id, alice.id, {
        clientMessageId: randomUUID(),
        body: 'Friend msg 2',
      });
      const ac = await service.sendToUser(alice.id, carol.id, {
        clientMessageId: randomUUID(),
        body: 'Outgoing request',
      });

      const friendsBox = await service.listConversations(alice.id, {
        box: MessagingInbox.FRIENDS,
        limit: 20,
      });
      expect(friendsBox.items).toHaveLength(1);
      expect(friendsBox.items[0]).toMatchObject({
        id: ab.conversationId,
        box: MessagingInbox.FRIENDS,
        requestDirection: null,
        unreadCount: 1,
        canSend: true,
      });

      const aliceRequests = await service.listConversations(alice.id, {
        box: MessagingInbox.REQUESTS,
        limit: 20,
      });
      expect(aliceRequests.items[0]).toMatchObject({
        id: ac.conversationId,
        box: MessagingInbox.REQUESTS,
        requestDirection: 'outgoing',
      });

      const carolRequests = await service.listConversations(carol.id, {
        box: MessagingInbox.REQUESTS,
        limit: 20,
      });
      expect(carolRequests.items[0]).toMatchObject({
        id: ac.conversationId,
        box: MessagingInbox.REQUESTS,
        requestDirection: 'incoming',
        unreadCount: 1,
      });

      // Mutual unfollow leaves requestDirection as null and box as requests.
      await unfollow(alice, carol);
      const afterUnfollow = await service.getConversation(
        carol.id,
        ac.conversationId,
      );
      expect(afterUnfollow).toMatchObject({
        box: MessagingInbox.REQUESTS,
        requestDirection: null,
        canSend: false,
      });

      // Cursor belonging to another box throws MESSAGE_CURSOR_INVALID.
      await expect(
        service.listConversations(alice.id, {
          box: MessagingInbox.FRIENDS,
          limit: 20,
          cursor: ac.conversationId,
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_CURSOR_INVALID' });

      // Non-participant getConversation throws NOT_FOUND.
      await expect(
        service.getConversation(admin.id, ab.conversationId),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('pages conversation history newest sequence first and rejects invalid cursors', async () => {
      await follow(alice, bob);
      const conv = await service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: 'm1',
      });
      const m2 = await service.sendToConversation(alice.id, conv.conversationId, {
        clientMessageId: randomUUID(),
        body: 'm2',
      });
      await service.sendToConversation(alice.id, conv.conversationId, {
        clientMessageId: randomUUID(),
        body: 'm3',
      });

      const page1 = await service.listMessages(alice.id, conv.conversationId, {
        limit: 2,
      });
      expect(page1.items.map((m) => m.body)).toEqual(['m3', 'm2']);
      expect(page1.nextCursor).toBe(m2.message.id);

      const page2 = await service.listMessages(alice.id, conv.conversationId, {
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items.map((m) => m.body)).toEqual(['m1']);
      expect(page2.nextCursor).toBeNull();

      await expect(
        service.listMessages(alice.id, conv.conversationId, {
          limit: 20,
          cursor: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_CURSOR_INVALID' });
    });
  });

  describe('markRead', () => {
    it('advances read sequence monotonically, records event only when advancing, and ignores non-members or foreign messages', async () => {
      await follow(alice, bob);
      await follow(bob, alice);
      const m1 = await service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: '1',
      });
      const m2 = await service.sendToConversation(
        alice.id,
        m1.conversationId,
        { clientMessageId: randomUUID(), body: '2' },
      );
      const m3 = await service.sendToConversation(
        alice.id,
        m1.conversationId,
        { clientMessageId: randomUUID(), body: '3' },
      );

      const read2 = await service.markRead(
        bob.id,
        m1.conversationId,
        m2.message.id,
      );
      expect(read2).toEqual({
        conversationId: m1.conversationId,
        readSequence: 2,
        unreadCount: 1,
      });

      // Marking an earlier message read never moves readSequence backwards or emits duplicate event.
      const read1 = await service.markRead(
        bob.id,
        m1.conversationId,
        m1.message.id,
      );
      expect(read1).toEqual({
        conversationId: m1.conversationId,
        readSequence: 2,
        unreadCount: 1,
      });
      expect(
        await events().countDocuments({
          type: MessagingEventType.CONVERSATION_READ,
        }),
      ).toBe(1);

      const read3 = await service.markRead(
        bob.id,
        m1.conversationId,
        m3.message.id,
      );
      expect(read3).toEqual({
        conversationId: m1.conversationId,
        readSequence: 3,
        unreadCount: 0,
      });

      await expect(
        service.markRead(bob.id, m1.conversationId, randomUUID()),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await expect(
        service.markRead(carol.id, m1.conversationId, m3.message.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });
});
