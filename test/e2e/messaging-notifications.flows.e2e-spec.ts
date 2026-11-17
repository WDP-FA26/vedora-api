import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  AccountStatus,
  type Notification,
  NotificationType,
  type User,
} from '../../src/mongo/models.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

/**
 * Gaps in the messaging contract (realtime-messaging.md) and the HTTP side of
 * notifications (notifications.md), through the full application.
 */
describe('Messaging and notification flows (HTTP)', () => {
  let e2e: E2eApp;
  let alice: User;
  let bob: User;
  let carol: User;
  const tokens = new Map<string, string>();
  const root = '/api/v1/messaging';

  const http = () => request(e2e.app.getHttpServer());
  const tokenOf = (user: User) => tokens.get(user.id) ?? '';
  const follow = (from: User, to: User) =>
    http()
      .put(`/api/v1/profiles/${to.id}/follow`)
      .auth(tokenOf(from), { type: 'bearer' })
      .expect(204);
  const unfollow = (from: User, to: User) =>
    http()
      .delete(`/api/v1/profiles/${to.id}/follow`)
      .auth(tokenOf(from), { type: 'bearer' })
      .expect(204);
  const send = (
    from: User,
    to: User,
    body: unknown,
    clientMessageId = randomUUID(),
  ) =>
    http()
      .post(`${root}/users/${to.id}/messages`)
      .auth(tokenOf(from), { type: 'bearer' })
      .send({ body, clientMessageId });
  const sendInto = (from: User, conversationId: string, body = 'Hi') =>
    http()
      .post(`${root}/conversations/${conversationId}/messages`)
      .auth(tokenOf(from), { type: 'bearer' })
      .send({ body, clientMessageId: randomUUID() });
  const inbox = (user: User, query: string) =>
    http()
      .get(`${root}/conversations?${query}`)
      .auth(tokenOf(user), { type: 'bearer' });
  const detail = (user: User, id: string) =>
    http()
      .get(`${root}/conversations/${id}`)
      .auth(tokenOf(user), { type: 'bearer' });
  const read = (user: User, id: string, messageId: string) =>
    http()
      .put(`${root}/conversations/${id}/read`)
      .auth(tokenOf(user), { type: 'bearer' })
      .send({ messageId });
  const notificationsRoute = '/api/v1/notifications';
  const notifications = () =>
    e2e.connection.model<Notification>('Notification');

  interface Sent {
    conversationId: string;
    message: { id: string; body: string; sequence: number };
  }
  const sent = (body: unknown): Sent => body as Sent;

  beforeAll(async () => {
    e2e = await createE2eApp('msgnotif_flows');
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 6);
    alice = await createUser(e2e.mongo, { username: `alice.${suffix}` });
    bob = await createUser(e2e.mongo, { username: `bob.${suffix}` });
    carol = await createUser(e2e.mongo, { username: `carol.${suffix}` });
    for (const user of [alice, bob, carol]) {
      tokens.set(user.id, await e2e.sign(user));
    }
  });

  afterAll(async () => e2e?.close());

  describe('message body', () => {
    it('refuses a whitespace-only body with 400 VALIDATION_FAILED', async () => {
      await follow(alice, bob);

      const response = await send(alice, bob, '   \n\t ').expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('creates no conversation when the body is refused', async () => {
      await follow(alice, bob);
      await send(alice, bob, '   ').expect(400);

      const contact = await http()
        .get(`${root}/users/${bob.id}`)
        .auth(tokenOf(alice), { type: 'bearer' })
        .expect(200);

      expect(contact.body).toMatchObject({ conversationId: null });
    });

    it('stores the body trimmed', async () => {
      await follow(alice, bob);

      const response = await send(alice, bob, '  Chào bạn!  ').expect(201);

      expect(sent(response.body).message.body).toBe('Chào bạn!');
    });

    it('accepts 2,000 characters surrounded by whitespace', async () => {
      await follow(alice, bob);

      await send(alice, bob, `  ${'a'.repeat(2000)}  `).expect(201);
    });

    it('refuses 2,001 characters after trimming', async () => {
      await follow(alice, bob);

      await send(alice, bob, 'a'.repeat(2001)).expect(400);
    });

    it('refuses a non-string body', async () => {
      await follow(alice, bob);

      await send(alice, bob, 42).expect(400);
    });

    it('treats a retry that differs only in surrounding whitespace as the same message', async () => {
      await follow(alice, bob);
      const clientMessageId = randomUUID();
      const first = await send(alice, bob, 'Hi', clientMessageId).expect(201);

      const retry = await send(alice, bob, ' Hi ', clientMessageId).expect(201);

      expect(sent(retry.body).message.id).toBe(sent(first.body).message.id);
    });
  });

  describe('recipient availability', () => {
    it('refuses a new message to a suspended recipient with 404', async () => {
      await follow(alice, bob);
      await e2e.connection
        .model<User>('User')
        .updateOne(
          { _id: bob.id },
          { $set: { status: AccountStatus.SUSPENDED } },
        );

      const response = await send(alice, bob, 'Hi').expect(404);

      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps the history but turns canSend off once the peer is suspended', async () => {
      await follow(alice, bob);
      const first = await send(alice, bob, 'Hi').expect(201);
      const { conversationId } = sent(first.body);
      await e2e.connection
        .model<User>('User')
        .updateOne(
          { _id: bob.id },
          { $set: { status: AccountStatus.SUSPENDED } },
        );

      const response = await detail(alice, conversationId).expect(200);

      expect(response.body).toMatchObject({
        followsPeer: true,
        canSend: false,
        lastMessage: { body: 'Hi' },
      });
    });
  });

  describe('membership', () => {
    it('answers 404 when a non-member sends into a conversation', async () => {
      await follow(alice, bob);
      const first = await send(alice, bob, 'Hi').expect(201);

      await sendInto(carol, sent(first.body).conversationId).expect(404);
    });

    it('answers 404 when a non-member reads a conversation', async () => {
      await follow(alice, bob);
      const first = await send(alice, bob, 'Hi').expect(201);

      await detail(carol, sent(first.body).conversationId).expect(404);
    });

    it('answers 404 to an inbox cursor from someone else’s conversation', async () => {
      await follow(alice, bob);
      const first = await send(alice, bob, 'Hi').expect(201);

      await inbox(
        carol,
        `box=requests&cursor=${sent(first.body).conversationId}`,
      ).expect(404);
    });

    it('answers 404 when marking read with a message from another conversation', async () => {
      await follow(alice, bob);
      await follow(alice, carol);
      const toBob = await send(alice, bob, 'Hi Bob').expect(201);
      const toCarol = await send(alice, carol, 'Hi Carol').expect(201);

      await read(
        bob,
        sent(toBob.body).conversationId,
        sent(toCarol.body).message.id,
      ).expect(404);
    });
  });

  describe('inbox classification and counters', () => {
    it('shows a one-way conversation as outgoing to the sender', async () => {
      await follow(alice, bob);
      await send(alice, bob, 'Hi').expect(201);

      const response = await inbox(alice, 'box=requests').expect(200);

      expect(response.body).toMatchObject({
        items: [
          { peer: { id: bob.id }, requestDirection: 'outgoing', canSend: true },
        ],
      });
    });

    it('shows a one-way conversation as incoming to the recipient, who cannot reply', async () => {
      await follow(alice, bob);
      await send(alice, bob, 'Hi').expect(201);

      const response = await inbox(bob, 'box=requests').expect(200);

      expect(response.body).toMatchObject({
        items: [
          {
            peer: { id: alice.id },
            requestDirection: 'incoming',
            canSend: false,
          },
        ],
      });
    });

    it('drops requestDirection to null once both sides unfollow', async () => {
      await follow(alice, bob);
      await send(alice, bob, 'Hi').expect(201);
      await unfollow(alice, bob);

      const response = await inbox(bob, 'box=requests').expect(200);

      expect(response.body).toMatchObject({
        items: [{ requestDirection: null, canSend: false }],
      });
    });

    it('counts unread messages for the recipient only', async () => {
      await follow(alice, bob);
      await send(alice, bob, 'One').expect(201);
      await send(alice, bob, 'Two').expect(201);

      const forBob = await inbox(bob, 'box=requests').expect(200);
      const forAlice = await inbox(alice, 'box=requests').expect(200);

      expect(forBob.body).toMatchObject({ items: [{ unreadCount: 2 }] });
      expect(forAlice.body).toMatchObject({ items: [{ unreadCount: 0 }] });
    });

    it('zeroes the unread count after reading the newest message', async () => {
      await follow(alice, bob);
      await send(alice, bob, 'One').expect(201);
      const second = await send(alice, bob, 'Two').expect(201);
      const { conversationId, message } = sent(second.body);

      const response = await read(bob, conversationId, message.id).expect(200);

      expect(response.body).toEqual({
        conversationId,
        readSequence: 2,
        unreadCount: 0,
      });
    });

    it('refuses a limit above 50', async () => {
      await inbox(alice, 'box=friends&limit=51').expect(400);
    });

    it('refuses an unknown inbox', async () => {
      await inbox(alice, 'box=archived').expect(400);
    });
  });

  describe('notification HTTP contract', () => {
    const list = (user: User, query = '') =>
      http()
        .get(query ? `${notificationsRoute}?${query}` : notificationsRoute)
        .auth(tokenOf(user), { type: 'bearer' });

    it('requires a token', async () => {
      await http().get(notificationsRoute).expect(401);
    });

    it('notifies the followed user once per follow, however often it is toggled', async () => {
      await follow(alice, bob);
      await unfollow(alice, bob);
      await follow(alice, bob);

      const response = await list(bob).expect(200);

      const follows = (
        response.body as { items: { type: NotificationType }[] }
      ).items.filter((item) => item.type === NotificationType.FOLLOW);
      expect(follows).toHaveLength(1);
    });

    it('lists a follow notification with its actor', async () => {
      await follow(alice, bob);

      const response = await list(bob).expect(200);

      expect(response.body).toMatchObject({
        items: [
          {
            type: NotificationType.FOLLOW,
            actor: { id: alice.id, username: alice.username },
            postId: null,
            commentId: null,
            readAt: null,
          },
        ],
        nextCursor: null,
      });
    });

    it('reports and clears the unread count', async () => {
      await follow(alice, bob);
      await follow(carol, bob);
      const before = await http()
        .get(`${notificationsRoute}/unread-count`)
        .auth(tokenOf(bob), { type: 'bearer' })
        .expect(200);

      await http()
        .post(`${notificationsRoute}/read`)
        .auth(tokenOf(bob), { type: 'bearer' })
        .expect(204);

      const after = await http()
        .get(`${notificationsRoute}/unread-count`)
        .auth(tokenOf(bob), { type: 'bearer' })
        .expect(200);
      expect(before.body).toEqual({ unreadCount: 2 });
      expect(after.body).toEqual({ unreadCount: 0 });
    });

    it('answers 204 but changes nothing when marking another user’s notification', async () => {
      await follow(alice, bob);
      const row = await notifications().findOne({ recipientId: bob.id }).exec();
      if (!row) throw new Error('missing notification');

      await http()
        .post(`${notificationsRoute}/${row.id}/read`)
        .auth(tokenOf(carol), { type: 'bearer' })
        .expect(204);

      expect(
        (await notifications().findById(row.id).exec())?.readAt,
      ).toBeNull();
    });

    it.each([
      ['limit=0'],
      ['limit=51'],
      ['limit=2.5'],
      ['limit=abc'],
      ['limit=1&limit=2'],
      ['cursor=not-a-uuid'],
      ['page=2'],
    ])('refuses ?%s with 400', async (query) => {
      await list(alice, query).expect(400);
    });

    it('refuses a non-UUID notification id with 400', async () => {
      await http()
        .post(`${notificationsRoute}/abc/read`)
        .auth(tokenOf(alice), { type: 'bearer' })
        .expect(400);
    });
  });
});
