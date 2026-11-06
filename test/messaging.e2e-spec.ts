import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { firstValueFrom, filter, timeout } from 'rxjs';
import { configureApp } from '../src/app.setup.js';
import { AppExceptionFilter } from '../src/common/exceptions/app-exception.filter.js';
import { MongoModule } from '../src/mongo/mongo.module.js';
import { MongoService } from '../src/mongo/mongo.service.js';
import {
  AccountStatus,
  Conversation,
  DirectMessage,
  MessagingEvent,
  MessagingEventType,
  User,
  UserRole,
} from '../src/mongo/models.js';
import { MessagingModule } from '../src/messaging/messaging.module.js';
import { MessagingEventsService } from '../src/messaging/messaging-events.service.js';
import { ProfilesModule } from '../src/profiles/profiles.module.js';
import { StorageService } from '../src/storage/storage.service.js';
import type {
  ConversationDto,
  ConversationPageDto,
  ConversationReadDto,
  MessagePageDto,
  SendMessageResponseDto,
} from '../src/messaging/dto/messaging.dto.js';
import { createUser } from './fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
    },
    { provide: StorageService, useValue: { isConfigured: () => false } },
  ],
  exports: [ConfigService, StorageService],
})
class MessagingTestSupportModule {}

type Frame = { type: string; data: Record<string, unknown> };
async function openStream(baseUrl: string, token: string) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/messaging/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const frames: Frame[] = [];
  const task = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const lines = chunk.split(/\r?\n/);
          const type = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (type && data)
            frames.push({
              type,
              data: JSON.parse(data) as Record<string, unknown>,
            });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    frames,
    async waitFor(
      type: string,
      predicate: (frame: Frame) => boolean = () => true,
    ) {
      await vi.waitFor(
        () =>
          expect(
            frames.some((frame) => frame.type === type && predicate(frame)),
          ).toBe(true),
        { timeout: 6000 },
      );
    },
    async close() {
      controller.abort();
      await task;
    },
  };
}

describe('Direct messaging (HTTP + MongoDB + realtime)', () => {
  let app: INestApplication<App>;
  let db: MongoService;
  let jwt: JwtService;
  let baseUrl: string;
  let alice: User;
  let bob: User;
  let carol: User;
  const tokens = new Map<string, string>();
  const root = '/api/v1/messaging';
  const conversations = () =>
    db.connection.model<Conversation>(Conversation.name);
  const messages = () => db.connection.model<DirectMessage>(DirectMessage.name);
  const events = () => db.connection.model<MessagingEvent>(MessagingEvent.name);
  const users = () => db.connection.model<User>(User.name);
  const token = (user: User) => tokens.get(user.id)!;
  const follow = (from: User, to: User) =>
    request(app.getHttpServer())
      .put(`/api/v1/profiles/${to.id}/follow`)
      .auth(token(from), { type: 'bearer' })
      .expect(204);
  const unfollow = (from: User, to: User) =>
    request(app.getHttpServer())
      .delete(`/api/v1/profiles/${to.id}/follow`)
      .auth(token(from), { type: 'bearer' })
      .expect(204);
  const send = (
    from: User,
    to: User,
    body = 'Hello',
    clientMessageId = randomUUID(),
  ) =>
    request(app.getHttpServer())
      .post(`${root}/users/${to.id}/messages`)
      .auth(token(from), { type: 'bearer' })
      .send({ body, clientMessageId });
  const inbox = (user: User, box = 'friends', suffix = '') =>
    request(app.getHttpServer())
      .get(`${root}/conversations?box=${box}${suffix}`)
      .auth(token(user), { type: 'bearer' });
  const detail = (user: User, id: string) =>
    request(app.getHttpServer())
      .get(`${root}/conversations/${id}`)
      .auth(token(user), { type: 'bearer' });
  const history = (user: User, id: string, suffix = '') =>
    request(app.getHttpServer())
      .get(`${root}/conversations/${id}/messages${suffix}`)
      .auth(token(user), { type: 'bearer' });
  const read = (user: User, id: string, messageId: string) =>
    request(app.getHttpServer())
      .put(`${root}/conversations/${id}/read`)
      .auth(token(user), { type: 'bearer' })
      .send({ messageId });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MessagingTestSupportModule,
        MongoModule.forTest(createTestMongoUrl('messaging_e2e')),
        JwtModule.register({
          global: true,
          secret: 'messaging-http-test-secret-at-least-32',
          signOptions: { expiresIn: 3600 },
        }),
        MessagingModule,
        ProfilesModule,
      ],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await prepareTestDatabase(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    db = app.get(MongoService);
    jwt = app.get(JwtService);
  });

  beforeEach(async () => {
    await users().deleteMany({});
    await conversations().deleteMany({});
    await events().deleteMany({});
    [alice, bob, carol] = await Promise.all([
      createUser(db, { username: 'message.alice' }),
      createUser(db, { username: 'message.bob' }),
      createUser(db, { username: 'message.carol', role: UserRole.ADMIN }),
    ]);
    tokens.clear();
    for (const user of [alice, bob, carol])
      tokens.set(
        user.id,
        await jwt.signAsync({ sub: user.id, username: user.username }),
      );
  });

  afterAll(async () => {
    if (!app) return;
    await dropTestDatabase(app);
    await app.close();
  });

  it.each([
    ['get', '/conversations'],
    ['get', '/events'],
    ['get', `/conversations/${randomUUID()}`],
    ['get', `/conversations/${randomUUID()}/messages`],
    ['post', `/users/${randomUUID()}/messages`],
    ['post', `/conversations/${randomUUID()}/messages`],
    ['put', `/conversations/${randomUUID()}/read`],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](`${root}${path}`).expect(401);
  });

  it('requires the sender to follow first and creates no empty conversation on rejection', async () => {
    const response = await send(alice, bob).expect(403);
    expect(response.body).toMatchObject({ code: 'MESSAGE_FOLLOW_REQUIRED' });
    expect(await conversations().countDocuments()).toBe(0);
    expect(await messages().countDocuments()).toBe(0);
    expect(await events().countDocuments()).toBe(0);
  });

  it('puts a one-way message in requests and allows its recipient to read but not reply', async () => {
    await follow(alice, bob);
    const sent = (await send(alice, bob, '  Hello Bob  ').expect(201))
      .body as SendMessageResponseDto;
    expect(sent.message.body).toBe('Hello Bob');
    const incoming = (await inbox(bob, 'requests').expect(200))
      .body as ConversationPageDto;
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0]).toMatchObject({
      id: sent.conversationId,
      box: 'requests',
      requestDirection: 'incoming',
      canSend: false,
      unreadCount: 1,
    });
    const outgoing = (await inbox(alice, 'requests').expect(200))
      .body as ConversationPageDto;
    expect(outgoing.items[0]).toMatchObject({
      requestDirection: 'outgoing',
      canSend: true,
      unreadCount: 0,
    });
    expect((await inbox(bob).expect(200)).body).toMatchObject({ items: [] });
    expect(
      (
        (await history(bob, sent.conversationId).expect(200))
          .body as MessagePageDto
      ).items[0].body,
    ).toBe('Hello Bob');
    await request(app.getHttpServer())
      .post(`${root}/conversations/${sent.conversationId}/messages`)
      .auth(token(bob), { type: 'bearer' })
      .send({ body: 'Reply', clientMessageId: randomUUID() })
      .expect(403);
  });

  it('moves both inboxes to friends after follow-back and reuses one conversation for replies', async () => {
    await follow(alice, bob);
    const first = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    await follow(bob, alice);
    for (const user of [alice, bob]) {
      expect(
        ((await inbox(user).expect(200)).body as ConversationPageDto).items[0],
      ).toMatchObject({
        id: first.conversationId,
        box: 'friends',
        requestDirection: null,
        canSend: true,
      });
      expect((await inbox(user, 'requests').expect(200)).body).toMatchObject({
        items: [],
      });
    }
    const reply = (
      await request(app.getHttpServer())
        .post(`${root}/conversations/${first.conversationId}/messages`)
        .auth(token(bob), { type: 'bearer' })
        .send({ body: 'Reply', clientMessageId: randomUUID() })
        .expect(201)
    ).body as SendMessageResponseDto;
    expect(reply.conversationId).toBe(first.conversationId);
    expect(reply.message.sequence).toBe(2);
    expect(await conversations().countDocuments()).toBe(1);
  });

  it('reclassifies after unfollow, revokes sending immediately, and preserves history', async () => {
    await follow(alice, bob);
    await follow(bob, alice);
    const first = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    await unfollow(alice, bob);
    await send(alice, bob).expect(403);
    await send(bob, alice).expect(201);
    expect(
      (await detail(alice, first.conversationId).expect(200))
        .body as ConversationDto,
    ).toMatchObject({
      box: 'requests',
      canSend: false,
      requestDirection: 'incoming',
    });
    await unfollow(bob, alice);
    expect(
      (await detail(alice, first.conversationId).expect(200))
        .body as ConversationDto,
    ).toMatchObject({
      box: 'requests',
      canSend: false,
      requestDirection: null,
    });
    expect(
      (
        (await history(alice, first.conversationId).expect(200))
          .body as MessagePageDto
      ).items,
    ).toHaveLength(2);
    await send(bob, alice).expect(403);
  });

  it('serializes send against unfollow rather than allowing future messages after revocation', async () => {
    await follow(alice, bob);
    const [sent] = await Promise.all([send(alice, bob), unfollow(alice, bob)]);
    expect([201, 403]).toContain(sent.status);
    const count = await messages().countDocuments();
    await send(alice, bob).expect(403);
    expect(await messages().countDocuments()).toBe(count);
  });

  it.each(
    ['', ' \n\t ', null, 123, ['hello'], 'a'.repeat(2001)].map((body) => ({
      body,
    })),
  )('rejects invalid message content %#', async ({ body }) => {
    await request(app.getHttpServer())
      .post(`${root}/users/${bob.id}/messages`)
      .auth(token(alice), { type: 'bearer' })
      .send({ body, clientMessageId: randomUUID() })
      .expect(400);
    expect(await conversations().countDocuments()).toBe(0);
  });

  it.each([
    {},
    { clientMessageId: 'invalid' },
    { clientMessageId: null },
    { clientMessageId: randomUUID(), senderId: 'spoof' },
  ])(
    'validates idempotency keys and rejects extra fields %#',
    async (fields) => {
      await request(app.getHttpServer())
        .post(`${root}/users/${bob.id}/messages`)
        .auth(token(alice), { type: 'bearer' })
        .send({ body: 'Hello', ...fields })
        .expect(400);
    },
  );

  it('accepts the maximum message length', async () => {
    await follow(alice, bob);
    await send(alice, bob, 'a'.repeat(2000)).expect(201);
    expect(await messages().countDocuments()).toBe(1);
  });

  it('rejects self-messaging', async () => {
    expect((await send(alice, alice).expect(400)).body).toMatchObject({
      code: 'SELF_MESSAGE_NOT_ALLOWED',
    });
  });

  it.each([AccountStatus.SUSPENDED, AccountStatus.PENDING_EMAIL])(
    'cannot send to an unavailable recipient (%s)',
    async (status) => {
      await follow(alice, bob);
      await users().updateOne({ _id: bob.id }, { $set: { status } });
      await send(alice, bob).expect(404);
      expect(await messages().countDocuments()).toBe(0);
    },
  );

  it('rejects a suspended sender and a token for a deleted account', async () => {
    await follow(alice, bob);
    await users().updateOne(
      { _id: alice.id },
      { $set: { status: AccountStatus.SUSPENDED } },
    );
    await send(alice, bob).expect(401);
    await users().deleteOne({ _id: alice.id });
    await inbox(alice).expect(401);
  });

  it('deduplicates concurrent retries and rejects changing the text under an existing key', async () => {
    await follow(alice, bob);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => send(alice, bob, 'Only once', key)),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(8).fill(201),
    );
    const ids = responses.map(
      (response) => (response.body as SendMessageResponseDto).message.id,
    );
    expect(new Set(ids).size).toBe(1);
    expect(await messages().countDocuments()).toBe(1);
    expect(
      await events().countDocuments({
        type: MessagingEventType.MESSAGE_CREATED,
      }),
    ).toBe(1);
    expect(
      (await send(alice, bob, 'Different text', key).expect(409)).body,
    ).toMatchObject({ code: 'MESSAGE_ID_CONFLICT' });
    expect((await conversations().findOne())?.sequence).toBe(1);
  }, 20000);

  it('orders simultaneous messages from both participants without duplicate conversations/sequences', async () => {
    await follow(alice, bob);
    await follow(bob, alice);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        index % 2
          ? send(alice, bob, `A${index}`)
          : send(bob, alice, `B${index}`),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(10).fill(201),
    );
    expect(await conversations().countDocuments()).toBe(1);
    expect(
      (await messages().find().sort({ sequence: 1 })).map(
        (row) => row.sequence,
      ),
    ).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
  }, 20000);

  it('never grants an unrelated admin access to a private conversation', async () => {
    await follow(alice, bob);
    const sent = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    await detail(carol, sent.conversationId).expect(404);
    await history(carol, sent.conversationId).expect(404);
    await read(carol, sent.conversationId, sent.message.id).expect(404);
    await request(app.getHttpServer())
      .post(`${root}/conversations/${sent.conversationId}/messages`)
      .auth(token(carol), { type: 'bearer' })
      .send({ body: 'Intrude', clientMessageId: randomUUID() })
      .expect(404);
    expect((await inbox(carol, 'requests').expect(200)).body).toMatchObject({
      items: [],
    });
    expect(await messages().countDocuments()).toBe(1);
  });

  it('paginates message sequences even when timestamps tie and rejects a cross-conversation cursor', async () => {
    await follow(alice, bob);
    await follow(alice, carol);
    let conversationId = '';
    for (let index = 0; index < 5; index++)
      conversationId = (
        (await send(alice, bob, `Message ${index}`).expect(201))
          .body as SendMessageResponseDto
      ).conversationId;
    await messages().updateMany(
      { conversationId },
      { $set: { createdAt: new Date('2026-11-06T00:00:00Z') } },
    );
    const sequences: number[] = [];
    let cursor: string | null = null;
    do {
      const page = (
        await history(
          bob,
          conversationId,
          `?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200)
      ).body as MessagePageDto;
      sequences.push(...page.items.map((item) => item.sequence));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sequences).toEqual([5, 4, 3, 2, 1]);
    const foreign = (await send(alice, carol).expect(201))
      .body as SendMessageResponseDto;
    expect(
      (
        await history(
          alice,
          conversationId,
          `?cursor=${foreign.message.id}`,
        ).expect(400)
      ).body,
    ).toMatchObject({ code: 'MESSAGE_CURSOR_INVALID' });
    await read(alice, conversationId, foreign.message.id).expect(404);
  });

  it('filters friends before limiting and pages tied conversation timestamps without duplicates', async () => {
    const dave = await createUser(db);
    await follow(alice, bob);
    await follow(alice, carol);
    await follow(carol, alice);
    await db.connection.model('Follow').create([
      { followerId: alice.id, followingId: dave.id },
      { followerId: dave.id, followingId: alice.id },
    ]);
    const strangers = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    const friend1 = (await send(alice, carol).expect(201))
      .body as SendMessageResponseDto;
    const friend2 = (await send(alice, dave, 'Friend 2').expect(201))
      .body as SendMessageResponseDto;
    await conversations().updateMany(
      {},
      { $set: { lastMessageAt: new Date('2026-11-06T00:00:00Z') } },
    );
    const first = (await inbox(alice, 'friends', '&limit=1').expect(200))
      .body as ConversationPageDto;
    const second = (
      await inbox(
        alice,
        'friends',
        `&limit=1&cursor=${first.nextCursor}`,
      ).expect(200)
    ).body as ConversationPageDto;
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)),
    ).toEqual(new Set([friend1.conversationId, friend2.conversationId]));
    expect(second.nextCursor).toBeNull();
    expect(
      (
        (await inbox(alice, 'requests').expect(200)).body as ConversationPageDto
      ).items.map((item) => item.id),
    ).toEqual([strangers.conversationId]);
  });

  it('keeps read receipts monotonic and counts only unread incoming messages', async () => {
    await follow(alice, bob);
    const first = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    const second = (await send(alice, bob).expect(201))
      .body as SendMessageResponseDto;
    expect(
      (
        (await detail(bob, first.conversationId).expect(200))
          .body as ConversationDto
      ).unreadCount,
    ).toBe(2);
    expect(
      (await read(bob, first.conversationId, first.message.id).expect(200))
        .body,
    ).toMatchObject({ readSequence: 1, unreadCount: 1 });
    await read(bob, first.conversationId, second.message.id).expect(200);
    const repeated = (
      await read(bob, first.conversationId, first.message.id).expect(200)
    ).body as ConversationReadDto;
    expect(repeated).toMatchObject({ readSequence: 2, unreadCount: 0 });
    expect(
      await events().countDocuments({
        type: MessagingEventType.CONVERSATION_READ,
      }),
    ).toBe(2);
    await send(alice, bob).expect(201);
    expect(
      (
        (await detail(bob, first.conversationId).expect(200))
          .body as ConversationDto
      ).unreadCount,
    ).toBe(1);
    expect(
      (await detail(alice, first.conversationId).expect(200))
        .body as ConversationDto,
    ).toMatchObject({ peerReadSequence: 2, myReadSequence: 0, unreadCount: 0 });
  });

  it.each(['box=invalid', 'limit=0', 'limit=51', 'cursor=invalid', 'page=1'])(
    'validates inbox query %s',
    async (query) => {
      await request(app.getHttpServer())
        .get(`${root}/conversations?${query}`)
        .auth(token(alice), { type: 'bearer' })
        .expect(400);
    },
  );

  it('validates UUID paths', async () => {
    await request(app.getHttpServer())
      .post(`${root}/users/invalid/messages`)
      .auth(token(alice), { type: 'bearer' })
      .send({ body: 'Hello', clientMessageId: randomUUID() })
      .expect(400);
  });

  it('cleans up private conversations, messages and outbox entries when a participant is deleted', async () => {
    await follow(alice, bob);
    await send(alice, bob).expect(201);
    await users().deleteOne({ _id: bob.id });
    expect(await conversations().countDocuments()).toBe(0);
    expect(await messages().countDocuments()).toBe(0);
    expect(await events().countDocuments()).toBe(0);
  });

  it('streams committed messages, follow changes and read receipts only to participants', async () => {
    const a = await openStream(baseUrl, token(alice));
    const b = await openStream(baseUrl, token(bob));
    const c = await openStream(baseUrl, token(carol));
    try {
      await Promise.all([
        a.waitFor('stream.ready'),
        b.waitFor('stream.ready'),
        c.waitFor('stream.ready'),
      ]);
      await follow(alice, bob);
      await b.waitFor('relationship.changed');
      const sent = (await send(alice, bob, 'very-private-text').expect(201))
        .body as SendMessageResponseDto;
      await Promise.all([
        a.waitFor('message.created'),
        b.waitFor('message.created'),
      ]);
      await read(bob, sent.conversationId, sent.message.id).expect(200);
      await a.waitFor(
        'conversation.read',
        (frame) => frame.data.readSequence === 1,
      );
      expect(
        c.frames.some((frame) =>
          [
            'message.created',
            'relationship.changed',
            'conversation.read',
          ].includes(frame.type),
        ),
      ).toBe(false);
      expect(JSON.stringify([...a.frames, ...b.frames])).not.toContain(
        'very-private-text',
      );
      expect(JSON.stringify([...a.frames, ...b.frames])).not.toContain(
        'userIds',
      );
      await follow(bob, alice);
      expect(
        (
          (await detail(bob, sent.conversationId).expect(200))
            .body as ConversationDto
        ).box,
      ).toBe('friends');
    } finally {
      await Promise.all([a.close(), b.close(), c.close()]);
    }
  }, 20000);

  it('shares committed events between independent watcher instances', async () => {
    const otherInstance = new MessagingEventsService(events());
    try {
      await firstValueFrom(
        otherInstance.stream(bob.id).pipe(
          filter((signal) => signal.type === 'ready'),
          timeout(6000),
        ),
      );
      const incoming = firstValueFrom(
        otherInstance.stream(bob.id).pipe(
          filter(
            (signal) => signal.type === MessagingEventType.MESSAGE_CREATED,
          ),
          timeout(6000),
        ),
      );
      await follow(alice, bob);
      const sent = (await send(alice, bob).expect(201))
        .body as SendMessageResponseDto;
      expect(await incoming).toMatchObject({
        type: 'message.created',
        conversationId: sent.conversationId,
        messageId: sent.message.id,
      });
    } finally {
      await otherInstance.onModuleDestroy();
    }
  }, 15000);

  it('closes a stream when the account is suspended before a new event', async () => {
    const stream = await openStream(baseUrl, token(bob));
    try {
      await stream.waitFor('stream.ready');
      await users().updateOne(
        { _id: bob.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );
      await events().create({
        userIds: [bob.id],
        type: MessagingEventType.RELATIONSHIP_CHANGED,
      });
      await stream.waitFor('session.expired');
      expect(
        stream.frames.some((frame) => frame.type === 'relationship.changed'),
      ).toBe(false);
    } finally {
      await stream.close();
    }
  }, 15000);

  it('does not deliver new events using an expired stream token', async () => {
    const shortToken = await jwt.signAsync(
      { sub: bob.id, username: bob.username },
      { expiresIn: 2 },
    );
    const stream = await openStream(baseUrl, shortToken);
    try {
      await stream.waitFor('stream.ready');
      await delay(2200);
      await events().create({
        userIds: [bob.id],
        type: MessagingEventType.RELATIONSHIP_CHANGED,
      });
      await stream.waitFor('session.expired');
      expect(
        stream.frames.some((frame) => frame.type === 'relationship.changed'),
      ).toBe(false);
    } finally {
      await stream.close();
    }
  }, 15000);

  it('documents inbox fields, message pages and the idempotency key in Swagger', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(
      doc.paths['/api/v1/messaging/conversations'].get?.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'box' }),
        expect.objectContaining({ name: 'cursor' }),
        expect.objectContaining({ name: 'limit' }),
      ]),
    );
    const sendSchema = doc.components?.schemas?.SendMessageDto;
    expect(
      sendSchema && 'required' in sendSchema && sendSchema.required,
    ).toEqual(expect.arrayContaining(['body', 'clientMessageId']));
    expect(doc.components?.schemas?.MessagePageDto).toMatchObject({
      properties: {
        items: { items: { $ref: '#/components/schemas/MessageDto' } },
      },
    });
  });
});
