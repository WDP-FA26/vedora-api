import type { MessageEvent } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { Model } from 'mongoose';
import { Subject } from 'rxjs';
import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import { UnauthenticatedException } from '@src/common/exceptions/unauthenticated.exception.js';
import type {
  ConversationDto,
  ConversationPageDto,
  ConversationReadDto,
  MessagePageDto,
  MessagingContactDto,
  SendMessageResponseDto,
} from '@src/messaging/dto/messaging.dto.js';
import { MessagingInbox } from '@src/messaging/dto/messaging.dto.js';
import type {
  MessagingEventsService,
  MessagingSignal,
} from '@src/messaging/messaging-events.service.js';
import { MessagingController } from '@src/messaging/messaging.controller.js';
import type { MessagingService } from '@src/messaging/messaging.service.js';
import {
  AccountStatus,
  MessagingEventType,
  User,
  UserRole,
} from '@src/mongo/models.js';

describe('MessagingController', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const peerId = '00000000-0000-4000-8000-000000000002';
  const convId = '00000000-0000-4000-8000-000000000003';
  const msgId = '00000000-0000-4000-8000-000000000004';
  const clientMessageId = '00000000-0000-4000-8000-000000000005';

  const makeReq = (authorization?: string) =>
    ({
      user: { sub: userId, username: 'alice', role: UserRole.USER },
      headers: authorization ? { authorization } : {},
    }) as AuthenticatedRequest;

  let service: ReturnType<typeof mockDeep<MessagingService>>;
  let signals: Subject<MessagingSignal>;
  let closed: Subject<void>;
  let isConnected: ReturnType<typeof vi.fn<() => boolean>>;
  let verifyAsync: ReturnType<typeof vi.fn<() => Promise<{ sub: string }>>>;
  let findUser: ReturnType<
    typeof vi.fn<() => Promise<{ status: AccountStatus } | null>>
  >;
  let controller: MessagingController;

  beforeEach(() => {
    vi.useFakeTimers();
    service = mockDeep<MessagingService>();
    signals = new Subject<MessagingSignal>();
    closed = new Subject<void>();
    isConnected = vi.fn<() => boolean>().mockReturnValue(true);
    verifyAsync = vi
      .fn<() => Promise<{ sub: string }>>()
      .mockResolvedValue({ sub: userId });
    findUser = vi
      .fn<() => Promise<{ status: AccountStatus } | null>>()
      .mockResolvedValue({ status: AccountStatus.ACTIVE });
    controller = new MessagingController(
      service,
      {
        stream: () => signals.asObservable(),
        isConnected,
        closed$: closed.asObservable(),
      } as unknown as MessagingEventsService,
      { verifyAsync } as unknown as JwtService,
      {
        findById: () => ({ select: () => ({ exec: findUser }) }),
      } as unknown as Model<User>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stream', () => {
    it('throws UnauthenticatedException when Bearer token is missing', () => {
      expect(() => controller.stream(makeReq())).toThrow(
        UnauthenticatedException,
      );
      expect(() => controller.stream(makeReq('Basic abc'))).toThrow(
        UnauthenticatedException,
      );
    });

    it('streams sanitized event frames and 15s heartbeat pings, and cleans up on unsubscribe', async () => {
      const seen: MessageEvent[] = [];
      const sub = controller
        .stream(makeReq('Bearer secret-jwt'))
        .subscribe((event) => seen.push(event));

      signals.next({ type: 'ready' });
      signals.next({ type: 'unavailable' });
      signals.next({
        type: MessagingEventType.MESSAGE_CREATED,
        id: 'evt-1',
        userIds: [userId, peerId],
        conversationId: convId,
        messageId: msgId,
        readerId: null,
        readSequence: null,
      });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(seen).toEqual([
        { type: 'stream.ready', data: {} },
        { type: 'stream.unavailable', data: {} },
        {
          type: MessagingEventType.MESSAGE_CREATED,
          id: 'evt-1',
          data: {
            conversationId: convId,
            messageId: msgId,
            readerId: null,
            readSequence: null,
          },
        },
        { type: 'ping', data: { connected: true } },
      ]);
      expect(JSON.stringify(seen)).not.toContain('secret-jwt');
      expect(JSON.stringify(seen)).not.toContain(peerId);

      sub.unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('emits session.expired and completes when JWT fails on live signal or user is inactive on heartbeat', async () => {
      verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
      const seenLive: MessageEvent[] = [];
      const completedLive = vi.fn();
      controller.stream(makeReq('Bearer token')).subscribe({
        next: (e) => seenLive.push(e),
        complete: completedLive,
      });
      signals.next({ type: 'ready' });
      await vi.advanceTimersByTimeAsync(0);
      expect(seenLive).toEqual([{ type: 'session.expired', data: {} }]);
      expect(completedLive).toHaveBeenCalledOnce();

      findUser.mockResolvedValueOnce({ status: AccountStatus.SUSPENDED });
      const seenPing: MessageEvent[] = [];
      const completedPing = vi.fn();
      controller.stream(makeReq('Bearer token')).subscribe({
        next: (e) => seenPing.push(e),
        complete: completedPing,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(seenPing).toEqual([{ type: 'session.expired', data: {} }]);
      expect(completedPing).toHaveBeenCalledOnce();

      findUser.mockResolvedValueOnce(null);
      const seenDeleted: MessageEvent[] = [];
      const completedDeleted = vi.fn();
      controller.stream(makeReq('Bearer token')).subscribe({
        next: (e) => seenDeleted.push(e),
        complete: completedDeleted,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(seenDeleted).toEqual([{ type: 'session.expired', data: {} }]);
      expect(completedDeleted).toHaveBeenCalledOnce();
    });

    it('drops queued live signals if unsubscribed while authentication is in flight', async () => {
      let resolveVerify: ((v: { sub: string }) => void) | undefined;
      verifyAsync.mockImplementationOnce(
        () =>
          new Promise<{ sub: string }>((resolve) => {
            resolveVerify = resolve;
          }),
      );
      const seen: MessageEvent[] = [];
      const sub = controller
        .stream(makeReq('Bearer token'))
        .subscribe((e) => seen.push(e));

      signals.next({ type: 'ready' });
      signals.next({ type: 'unavailable' });
      sub.unsubscribe();

      resolveVerify?.({ sub: userId });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([]);
    });

    it('ignores malformed signals in live stream without crashing the heartbeat', async () => {
      const seen: MessageEvent[] = [];
      const sub = controller
        .stream(makeReq('Bearer token'))
        .subscribe((e) => seen.push(e));
      signals.next(null as unknown as MessagingSignal);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(seen).toEqual([{ type: 'ping', data: { connected: true } }]);
      sub.unsubscribe();
    });

    it('completes on shutdown closed$ signal', () => {
      const completed = vi.fn();
      controller
        .stream(makeReq('Bearer token'))
        .subscribe({ complete: completed });
      closed.next();
      expect(completed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('delegates REST endpoints to MessagingService with authenticated userId', async () => {
    const req = makeReq('Bearer token');
    const convPage = { items: [], nextCursor: null } as ConversationPageDto;
    const conv = { id: convId } as unknown as ConversationDto;
    const msgPage = { items: [], nextCursor: null } as MessagePageDto;
    const contact = { conversationId: null } as unknown as MessagingContactDto;
    const sent = {
      conversationId: convId,
    } as unknown as SendMessageResponseDto;
    const readRes: ConversationReadDto = {
      conversationId: convId,
      readSequence: 2,
      unreadCount: 0,
    };

    service.listConversations.mockResolvedValue(convPage);
    service.getConversation.mockResolvedValue(conv);
    service.listMessages.mockResolvedValue(msgPage);
    service.contact.mockResolvedValue(contact);
    service.sendToUser.mockResolvedValue(sent);
    service.sendToConversation.mockResolvedValue(sent);
    service.markRead.mockResolvedValue(readRes);

    const convQuery = { box: MessagingInbox.FRIENDS, limit: 20 };
    await expect(controller.list(req, convQuery)).resolves.toBe(convPage);
    expect(service.listConversations).toHaveBeenCalledExactlyOnceWith(
      userId,
      convQuery,
    );

    await expect(controller.get(req, convId)).resolves.toBe(conv);
    expect(service.getConversation).toHaveBeenCalledExactlyOnceWith(
      userId,
      convId,
    );

    const msgQuery = { limit: 30, cursor: msgId };
    await expect(controller.messages(req, convId, msgQuery)).resolves.toBe(
      msgPage,
    );
    expect(service.listMessages).toHaveBeenCalledExactlyOnceWith(
      userId,
      convId,
      msgQuery,
    );

    await expect(controller.contact(req, peerId)).resolves.toBe(contact);
    expect(service.contact).toHaveBeenCalledExactlyOnceWith(userId, peerId);

    const sendDto = { clientMessageId, body: 'Hello' };
    await expect(controller.sendToUser(req, peerId, sendDto)).resolves.toBe(
      sent,
    );
    expect(service.sendToUser).toHaveBeenCalledExactlyOnceWith(
      userId,
      peerId,
      sendDto,
    );

    await expect(controller.send(req, convId, sendDto)).resolves.toBe(sent);
    expect(service.sendToConversation).toHaveBeenCalledExactlyOnceWith(
      userId,
      convId,
      sendDto,
    );

    await expect(
      controller.read(req, convId, { messageId: msgId }),
    ).resolves.toBe(readRes);
    expect(service.markRead).toHaveBeenCalledExactlyOnceWith(
      userId,
      convId,
      msgId,
    );
  });
});
