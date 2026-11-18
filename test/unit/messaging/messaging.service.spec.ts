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
  Post,
  PostStatus,
  PostType,
  type User,
  UserRole,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { createPost, createUser } from '../../support/fixtures.js';
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
  const events = () => db.connection.model<MessagingEvent>(MessagingEvent.name);

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

  describe('global unread count', () => {
    it('counts only incoming unread messages across friends and requests and respects read positions', async () => {
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 0 });
      await follow(alice, bob);
      await follow(carol, bob);
      await follow(bob, carol);
      const first = await service.sendToUser(alice.id, bob.id, {
        body: 'Request',
        clientMessageId: randomUUID(),
      });
      await service.sendToUser(alice.id, bob.id, {
        body: 'Another',
        clientMessageId: randomUUID(),
      });
      const friend = await service.sendToUser(carol.id, bob.id, {
        body: 'Friend',
        clientMessageId: randomUUID(),
      });
      await service.sendToUser(bob.id, carol.id, {
        body: 'Outgoing',
        clientMessageId: randomUUID(),
      });
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 3 });
      expect(await service.unreadCount(admin.id)).toEqual({ unreadCount: 0 });
      await service.markRead(bob.id, first.conversationId, first.message.id);
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 2 });
      await service.markRead(bob.id, friend.conversationId, friend.message.id);
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 1 });
    });

    it('excludes privately deleted requests, counts new messages again, and preserves the sender view', async () => {
      await follow(alice, bob);
      const first = await service.sendToUser(alice.id, bob.id, {
        body: 'Old',
        clientMessageId: randomUUID(),
      });
      await service.deleteRequest(
        bob.id,
        first.conversationId,
        first.message.id,
      );
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 0 });
      const newer = await service.sendToUser(alice.id, bob.id, {
        body: 'New',
        clientMessageId: randomUUID(),
      });
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 1 });
      await service.acceptRequest(bob.id, first.conversationId);
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 1 });
      await service.markRead(bob.id, first.conversationId, newer.message.id);
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 0 });
      expect(
        (
          await service.listMessages(alice.id, first.conversationId, {
            limit: 20,
          })
        ).items,
      ).toHaveLength(2);
    });

    it('includes conversations beyond the first inbox page', async () => {
      for (let index = 0; index < 22; index++) {
        const peer = await createUser(db);
        await follow(peer, alice);
        await service.sendToUser(peer.id, alice.id, {
          body: 'Unread',
          clientMessageId: randomUUID(),
        });
      }
      const firstPage = await service.listConversations(alice.id, {
        box: MessagingInbox.REQUESTS,
        limit: 20,
      });
      expect(firstPage.items).toHaveLength(20);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(await service.unreadCount(alice.id)).toEqual({ unreadCount: 22 });
      expect(await service.unreadCount(bob.id)).toEqual({ unreadCount: 0 });
    });
  });

  describe('shared posts', () => {
    it('shares a public post through the existing message pipeline and hydrates history', async () => {
      await follow(alice, bob);
      const post = await createPost(db, {
        authorId: carol.id,
        body: 'A public recipe',
      });
      const clientMessageId = randomUUID();
      const result = await service.sharePostToUser(alice.id, bob.id, {
        postId: post.id,
        clientMessageId,
      });
      expect(result.message).toMatchObject({
        sharedPostId: post.id,
        sequence: 1,
        sharedPost: {
          id: post.id,
          type: PostType.POST,
          title: null,
          excerpt: 'A public recipe',
          author: { id: carol.id },
        },
      });
      expect(
        await messages().countDocuments({
          conversationId: result.conversationId,
        }),
      ).toBe(1);
      expect(
        await events().countDocuments({
          conversationId: result.conversationId,
          type: MessagingEventType.MESSAGE_CREATED,
        }),
      ).toBe(1);
      expect(
        (
          await service.listMessages(bob.id, result.conversationId, {
            limit: 10,
          })
        ).items[0],
      ).toMatchObject({ sharedPostId: post.id, sharedPost: { id: post.id } });
      expect(
        (await service.getConversation(bob.id, result.conversationId))
          .unreadCount,
      ).toBe(1);
      const stored = await messages()
        .findById(result.message.id)
        .lean()
        .orFail();
      expect(stored).not.toHaveProperty('sharedPost');
      expect(stored.body).not.toContain('A public recipe');
    });

    it('supports blogs and accepted requests without following', async () => {
      await follow(alice, bob);
      const original = await service.sendToUser(alice.id, bob.id, {
        body: 'Hello',
        clientMessageId: randomUUID(),
      });
      await service.acceptRequest(bob.id, original.conversationId);
      await unfollow(alice, bob);
      const blog = await createPost(db, {
        authorId: carol.id,
        type: PostType.BLOG,
        blog: {
          title: 'Cooking blog',
          excerpt: 'Plain excerpt',
          content: 'Private draft details never copied',
          coverImageUrl: 'https://example.test/cover.png',
          recipeIds: [],
        },
      });
      const shared = await service.sharePostToConversation(
        bob.id,
        original.conversationId,
        { postId: blog.id, clientMessageId: randomUUID() },
      );
      expect(shared.message.sharedPost).toMatchObject({
        type: PostType.BLOG,
        title: 'Cooking blog',
        excerpt: 'Plain excerpt',
        imageUrl: 'https://example.test/cover.png',
      });
      expect(JSON.stringify(shared.message)).not.toContain(
        'Private draft details never copied',
      );
    });

    it('deduplicates simultaneous retries and rejects reuse with different content', async () => {
      await follow(alice, bob);
      const one = await createPost(db, { authorId: carol.id });
      const two = await createPost(db, { authorId: carol.id });
      const dto = { postId: one.id, clientMessageId: randomUUID() };
      const result = await Promise.all(
        Array.from({ length: 4 }, () =>
          service.sharePostToUser(alice.id, bob.id, dto),
        ),
      );
      expect(new Set(result.map((row) => row.message.id)).size).toBe(1);
      expect(await messages().countDocuments({})).toBe(1);
      expect(
        await events().countDocuments({
          type: MessagingEventType.MESSAGE_CREATED,
        }),
      ).toBe(1);
      await expect(
        service.sharePostToUser(alice.id, bob.id, { ...dto, postId: two.id }),
      ).rejects.toBeInstanceOf(StateConflictException);
      await expect(
        service.sendToUser(alice.id, bob.id, {
          body: result[0].message.body,
          clientMessageId: dto.clientMessageId,
        }),
      ).rejects.toBeInstanceOf(StateConflictException);
    });

    it('rejects missing, unpublished, or unauthorized shares without creating messages or outbox events', async () => {
      const hidden = await createPost(db, {
        authorId: alice.id,
        status: PostStatus.DRAFT,
      });
      const published = await createPost(db, { authorId: alice.id });
      await expect(
        service.sharePostToUser(alice.id, bob.id, {
          postId: published.id,
          clientMessageId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(AccessDeniedException);
      await follow(alice, bob);
      for (const postId of [randomUUID(), hidden.id]) {
        await expect(
          service.sharePostToUser(alice.id, bob.id, {
            postId,
            clientMessageId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'SHARED_POST_UNAVAILABLE' });
      }
      expect(await conversations().countDocuments({})).toBe(0);
      expect(await messages().countDocuments({})).toBe(0);
      expect(await events().countDocuments({})).toBe(0);
    });

    it('keeps history but strips previews after unpublishing or deleting a shared post, including retries', async () => {
      await follow(alice, bob);
      const post = await createPost(db, {
        authorId: carol.id,
        body: 'Sensitive after removal',
      });
      const dto = { postId: post.id, clientMessageId: randomUUID() };
      const shared = await service.sharePostToUser(alice.id, bob.id, dto);
      await db.connection
        .model<Post>(Post.name)
        .updateOne({ _id: post.id }, { $set: { status: PostStatus.REJECTED } });
      const hidden = await service.listMessages(bob.id, shared.conversationId, {
        limit: 10,
      });
      expect(hidden.items[0]).toMatchObject({
        sharedPostId: post.id,
        sharedPost: null,
      });
      expect(JSON.stringify(hidden)).not.toContain('Sensitive after removal');
      await db.withTransaction((session) =>
        db.connection
          .model(Post.name)
          .deleteOne({ _id: post.id }, { session })
          .exec(),
      );
      const retry = await service.sharePostToUser(alice.id, bob.id, dto);
      expect(retry.message).toMatchObject({
        id: shared.message.id,
        sharedPost: null,
      });
      expect(await messages().countDocuments({})).toBe(1);
      await expect(
        service.sharePostToConversation(carol.id, shared.conversationId, dto),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
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

      // A request keeps its initiator after unfollow, so its recipient can still accept it.
      await unfollow(alice, carol);
      const afterUnfollow = await service.getConversation(
        carol.id,
        ac.conversationId,
      );
      expect(afterUnfollow).toMatchObject({
        box: MessagingInbox.REQUESTS,
        requestDirection: 'incoming',
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
      const m2 = await service.sendToConversation(
        alice.id,
        conv.conversationId,
        {
          clientMessageId: randomUUID(),
          body: 'm2',
        },
      );
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

  describe('message request actions', () => {
    const send = async () => {
      await follow(alice, bob);
      return service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: 'request',
      });
    };

    it('accepts without following back and preserves both-way permission after every follow is removed', async () => {
      const sent = await send();
      await expect(
        service.sendToConversation(bob.id, sent.conversationId, {
          clientMessageId: randomUUID(),
          body: 'too early',
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_FOLLOW_REQUIRED' });
      expect(
        await service.getConversation(bob.id, sent.conversationId),
      ).toMatchObject({ canAcceptRequest: true, canDeleteRequest: true });
      const accepted = await service.acceptRequest(bob.id, sent.conversationId);
      expect(accepted).toMatchObject({
        box: MessagingInbox.FRIENDS,
        canSend: true,
        followsPeer: false,
        canAcceptRequest: false,
        canDeleteRequest: false,
      });
      await unfollow(alice, bob);
      expect(await follows().countDocuments()).toBe(0);
      await service.sendToConversation(bob.id, sent.conversationId, {
        clientMessageId: randomUUID(),
        body: 'reply',
      });
      await service.sendToUser(alice.id, bob.id, {
        clientMessageId: randomUUID(),
        body: 'continued',
      });
      expect(await service.contact(bob.id, alice.id)).toMatchObject({
        canSend: true,
        box: MessagingInbox.FRIENDS,
        followsPeer: false,
      });
      for (const user of [alice, bob]) {
        expect(
          (
            await service.listConversations(user.id, {
              box: MessagingInbox.FRIENDS,
              limit: 1,
            })
          ).items.map((row) => row.id),
        ).toEqual([sent.conversationId]);
        expect(
          (
            await service.listConversations(user.id, {
              box: MessagingInbox.REQUESTS,
              limit: 1,
            })
          ).items,
        ).toEqual([]);
      }
      await service.acceptRequest(bob.id, sent.conversationId);
      expect(
        await events().countDocuments({
          type: MessagingEventType.REQUEST_ACCEPTED,
        }),
      ).toBe(1);
    });

    it('refuses sender self-acceptance/deletion and non-member or administrator access', async () => {
      const sent = await send();
      await unfollow(alice, bob);
      await expect(
        service.acceptRequest(alice.id, sent.conversationId),
      ).rejects.toMatchObject({ code: 'MESSAGE_REQUEST_RECEIVER_REQUIRED' });
      await expect(
        service.deleteRequest(alice.id, sent.conversationId, sent.message.id),
      ).rejects.toMatchObject({ code: 'MESSAGE_REQUEST_RECEIVER_REQUIRED' });
      for (const user of [carol, admin]) {
        await expect(
          service.acceptRequest(user.id, sent.conversationId),
        ).rejects.toBeInstanceOf(ResourceNotFoundException);
        await expect(
          service.deleteRequest(user.id, sent.conversationId, sent.message.id),
        ).rejects.toBeInstanceOf(ResourceNotFoundException);
      }
      expect(
        (await conversations().findById(sent.conversationId))?.acceptedAt,
      ).toBeNull();
    });

    it('supports existing rows without initiator/acceptance/cutoff fields using their first message', async () => {
      const sent = await send();
      await conversations().updateOne(
        { _id: sent.conversationId },
        {
          $unset: {
            requestInitiatorId: 1,
            acceptedAt: 1,
            lowDeletedThroughSequence: 1,
            highDeletedThroughSequence: 1,
          },
        },
      );
      await unfollow(alice, bob);
      expect(
        await service.getConversation(bob.id, sent.conversationId),
      ).toMatchObject({ requestDirection: 'incoming', canAcceptRequest: true });
      expect(
        await service.acceptRequest(bob.id, sent.conversationId),
      ).toMatchObject({ box: MessagingInbox.FRIENDS, canSend: true });
    });

    it.each([true, false])(
      'deletes only the recipient history when the initiator is the lower participant: %s',
      async (senderIsLow) => {
        const pair = [alice, bob].sort((a, b) => a.id.localeCompare(b.id));
        const sender = pair[senderIsLow ? 0 : 1],
          receiver = pair[senderIsLow ? 1 : 0];
        await follow(sender, receiver);
        const sent = await service.sendToUser(sender.id, receiver.id, {
          clientMessageId: randomUUID(),
          body: 'private deletion',
        });
        expect(
          await service.deleteRequest(
            receiver.id,
            sent.conversationId,
            sent.message.id,
          ),
        ).toEqual({
          conversationId: sent.conversationId,
          deletedThroughSequence: 1,
        });
        expect(
          (
            await service.listConversations(receiver.id, {
              box: MessagingInbox.REQUESTS,
              limit: 20,
            })
          ).items,
        ).toEqual([]);
        await expect(
          service.getConversation(receiver.id, sent.conversationId),
        ).rejects.toBeInstanceOf(ResourceNotFoundException);
        await expect(
          service.listMessages(receiver.id, sent.conversationId, { limit: 20 }),
        ).rejects.toBeInstanceOf(ResourceNotFoundException);
        expect(await service.contact(receiver.id, sender.id)).toMatchObject({
          conversationId: null,
        });
        expect(
          (
            await service.listMessages(sender.id, sent.conversationId, {
              limit: 20,
            })
          ).items,
        ).toHaveLength(1);
        expect(
          (await service.getConversation(sender.id, sent.conversationId))
            .peerReadSequence,
        ).toBe(0);
        expect(await messages().countDocuments()).toBe(1);
        expect(
          await events().findOne({ type: MessagingEventType.REQUEST_DELETED }),
        ).toMatchObject({ userIds: [receiver.id], messageId: null });
      },
    );

    it('keeps messages newer than the delete marker, hides old cursors, and makes retries safe', async () => {
      const old = await send();
      const newer = await service.sendToConversation(
        alice.id,
        old.conversationId,
        { clientMessageId: randomUUID(), body: 'new request' },
      );
      await service.deleteRequest(bob.id, old.conversationId, old.message.id);
      expect(
        (
          await service.listMessages(bob.id, old.conversationId, { limit: 20 })
        ).items.map((row) => row.id),
      ).toEqual([newer.message.id]);
      expect(
        await service.getConversation(bob.id, old.conversationId),
      ).toMatchObject({
        unreadCount: 1,
        canAcceptRequest: true,
        myReadSequence: 1,
      });
      await service.deleteRequest(bob.id, old.conversationId, old.message.id);
      expect(
        await events().countDocuments({
          type: MessagingEventType.REQUEST_DELETED,
        }),
      ).toBe(1);
      await expect(
        service.listMessages(bob.id, old.conversationId, {
          limit: 20,
          cursor: old.message.id,
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_CURSOR_INVALID' });
      await expect(
        service.markRead(bob.id, old.conversationId, old.message.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.deleteRequest(bob.id, old.conversationId, randomUUID()),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('shows a new request after deletion without resurrecting old messages on a send retry', async () => {
      const old = await send();
      await service.deleteRequest(bob.id, old.conversationId, old.message.id);
      await service.sendToUser(alice.id, bob.id, {
        clientMessageId: old.message.clientMessageId,
        body: old.message.body,
      });
      expect(
        (
          await service.listConversations(bob.id, {
            box: MessagingInbox.REQUESTS,
            limit: 20,
          })
        ).items,
      ).toEqual([]);
      const newer = await service.sendToConversation(
        alice.id,
        old.conversationId,
        { clientMessageId: randomUUID(), body: 'another hello' },
      );
      expect(
        (
          await service.listConversations(bob.id, {
            box: MessagingInbox.REQUESTS,
            limit: 20,
          })
        ).items[0],
      ).toMatchObject({
        id: old.conversationId,
        unreadCount: 1,
        lastMessage: { id: newer.message.id },
      });
      await service.acceptRequest(bob.id, old.conversationId);
      expect(
        (
          await service.listMessages(bob.id, old.conversationId, { limit: 20 })
        ).items.map((row) => row.body),
      ).toEqual(['another hello']);
    });

    it('does not let a stale delete hide an accepted conversation', async () => {
      const sent = await send();
      await service.acceptRequest(bob.id, sent.conversationId);
      await expect(
        service.deleteRequest(bob.id, sent.conversationId, sent.message.id),
      ).rejects.toMatchObject({ code: 'MESSAGE_REQUEST_NOT_PENDING' });
      expect(
        (await service.getConversation(bob.id, sent.conversationId)).box,
      ).toBe(MessagingInbox.FRIENDS);
    });

    it('serializes concurrent acceptance and deletion without hiding an accepted conversation', async () => {
      const sent = await send();
      await Promise.allSettled([
        service.acceptRequest(bob.id, sent.conversationId),
        service.deleteRequest(bob.id, sent.conversationId, sent.message.id),
      ]);
      const row = await conversations().findById(sent.conversationId).orFail();
      const accepted = Boolean(row.acceptedAt);
      const visible = (
        await service.listConversations(bob.id, {
          box: accepted ? MessagingInbox.FRIENDS : MessagingInbox.REQUESTS,
          limit: 20,
        })
      ).items.length;
      expect(visible).toBe(accepted ? 1 : 0);
      expect(
        (row.lowId === bob.id
          ? row.lowDeletedThroughSequence
          : row.highDeletedThroughSequence) > 0,
      ).toBe(!accepted);
    });

    it('keeps account restrictions after acceptance and allows discarding an unavailable request', async () => {
      const sent = await send();
      await users().updateOne(
        { _id: alice.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );
      await expect(
        service.acceptRequest(bob.id, sent.conversationId),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.deleteRequest(bob.id, sent.conversationId, sent.message.id),
      ).resolves.toMatchObject({ deletedThroughSequence: 1 });
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
      const m2 = await service.sendToConversation(alice.id, m1.conversationId, {
        clientMessageId: randomUUID(),
        body: '2',
      });
      const m3 = await service.sendToConversation(alice.id, m1.conversationId, {
        clientMessageId: randomUUID(),
        body: '3',
      });

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
