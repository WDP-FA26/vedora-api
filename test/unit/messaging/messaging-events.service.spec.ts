import type { ClientSession, Model } from 'mongoose';
import {
  MessagingEventsService,
  type MessagingSignal,
} from '@src/messaging/messaging-events.service.js';
import { MessagingEvent, MessagingEventType } from '@src/mongo/models.js';

interface FakeWatcher {
  closed: boolean;
  tryNext: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function makeEvent(
  id: string,
  userIds: string[],
  type = MessagingEventType.MESSAGE_CREATED,
): MessagingEvent {
  return {
    _id: id,
    id,
    userIds,
    type,
    conversationId: 'conv-1',
    messageId: 'msg-1',
    readerId: null,
    readSequence: null,
    createdAt: new Date(),
  };
}

describe('MessagingEventsService', () => {
  const userA = '00000000-0000-4000-8000-000000000001';
  const userB = '00000000-0000-4000-8000-000000000002';
  const userC = '00000000-0000-4000-8000-000000000003';

  let initMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let createMock: ReturnType<typeof vi.fn>;
  let watchMock: ReturnType<typeof vi.fn<() => FakeWatcher>>;
  let service: MessagingEventsService;

  beforeEach(() => {
    initMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    createMock = vi.fn().mockResolvedValue([]);
    watchMock = vi.fn<() => FakeWatcher>();
    const model = {
      init: initMock,
      create: createMock,
      collection: { watch: watchMock },
    } as unknown as Model<MessagingEvent>;
    service = new MessagingEventsService(model);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.onModuleDestroy();
  });

  it('deduplicates userIds when recording an outbox event in a session', async () => {
    const session = { id: 'sess' } as unknown as ClientSession;

    await service.record(
      [userA, userB, userA],
      {
        type: MessagingEventType.MESSAGE_CREATED,
        conversationId: 'conv-1',
        messageId: 'msg-1',
      },
      session,
    );

    expect(createMock).toHaveBeenCalledExactlyOnceWith(
      [
        {
          userIds: [userA, userB],
          type: MessagingEventType.MESSAGE_CREATED,
          conversationId: 'conv-1',
          messageId: 'msg-1',
        },
      ],
      { session },
    );
  });

  it('fans out inserted events only to matching participants and emits ready on connect', async () => {
    let resolver: ((value: unknown) => void) | undefined;
    const watcher: FakeWatcher = {
      closed: false,
      tryNext: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce({
          operationType: 'insert',
          fullDocument: makeEvent('evt-1', [userA, userB]),
        })
        .mockResolvedValueOnce({
          operationType: 'insert',
          fullDocument: makeEvent('evt-2', [userB, userC]),
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolver = resolve;
            }),
        ),
      close: vi.fn<() => Promise<void>>().mockImplementation(() => {
        watcher.closed = true;
        resolver?.(null);
        return Promise.resolve();
      }),
    };
    watchMock.mockReturnValue(watcher);

    const seenA: MessagingSignal[] = [];
    const seenC: MessagingSignal[] = [];
    const subA = service.stream(userA).subscribe((s) => seenA.push(s));
    const subC = service.stream(userC).subscribe((s) => seenC.push(s));

    await vi.waitFor(() => expect(service.isConnected()).toBe(true));
    await vi.waitFor(() =>
      expect(seenC.some((s) => 'id' in s && s.id === 'evt-2')).toBe(true),
    );

    expect(initMock).toHaveBeenCalledOnce();
    expect(watchMock).toHaveBeenCalledOnce();
    expect(seenA.map((s) => ('id' in s ? s.id : s.type))).toEqual([
      'unavailable',
      'ready',
      'evt-1',
    ]);
    expect(seenC.map((s) => ('id' in s ? s.id : s.type))).toEqual([
      'unavailable',
      'ready',
      'evt-2',
    ]);

    const seenLate: MessagingSignal[] = [];
    const subLate = service.stream(userA).subscribe((s) => seenLate.push(s));
    expect(seenLate[0]).toEqual({ type: 'ready' });

    subA.unsubscribe();
    subC.unsubscribe();
    subLate.unsubscribe();
  });

  it('emits unavailable and retries after 3s when the change stream fails', async () => {
    vi.useFakeTimers();
    const firstWatcher: FakeWatcher = {
      closed: false,
      tryNext: vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new Error('not a replica set')),
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    let parkResolve: ((v: unknown) => void) | undefined;
    const secondWatcher: FakeWatcher = {
      closed: false,
      tryNext: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              parkResolve = resolve;
            }),
        ),
      close: vi.fn<() => Promise<void>>().mockImplementation(() => {
        secondWatcher.closed = true;
        parkResolve?.(null);
        return Promise.resolve();
      }),
    };
    watchMock
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(secondWatcher);

    const seen: MessagingSignal[] = [];
    const sub = service.stream(userA).subscribe((s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isConnected()).toBe(false);
    expect(firstWatcher.close).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ type: 'unavailable' }, { type: 'unavailable' }]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(service.isConnected()).toBe(true);
    expect(seen.at(-1)).toEqual({ type: 'ready' });

    sub.unsubscribe();
  });

  it('clears a pending retry timer on shutdown', async () => {
    vi.useFakeTimers();
    const failingWatcher: FakeWatcher = {
      closed: false,
      tryNext: vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new Error('replica set unavailable')),
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    watchMock.mockReturnValue(failingWatcher);

    const sub = service.stream(userA).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    sub.unsubscribe();
  });

  it('stops cleanly during onModuleDestroy even if stopped while initial probe is pending', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((v: unknown) => void) | undefined;
    const watcher: FakeWatcher = {
      closed: false,
      tryNext: vi.fn<() => Promise<unknown>>().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      ),
      close: vi.fn<() => Promise<void>>().mockImplementation(() => {
        watcher.closed = true;
        resolveFirst?.(null);
        return Promise.resolve();
      }),
    };
    watchMock.mockReturnValue(watcher);

    const closed = vi.fn();
    service.closed$.subscribe(closed);
    const sub = service.stream(userA).subscribe();
    await vi.advanceTimersByTimeAsync(0);

    await service.onModuleDestroy();
    expect(closed).toHaveBeenCalledOnce();
    expect(service.isConnected()).toBe(false);
    sub.unsubscribe();
  });
});
