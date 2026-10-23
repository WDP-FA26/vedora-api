import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { PaymentEventsService, PaymentSignal } from './payment-events.service';

vi.mock('redis', () => ({ createClient: vi.fn() }));

class FakeRedis extends EventEmitter {
  isOpen = false;
  listener?: (raw: string) => void;
  connect = vi.fn(() => {
    this.isOpen = true;
    return Promise.resolve();
  });
  subscribe = vi.fn((channel: string, callback: (raw: string) => void) => {
    void channel;
    this.listener = callback;
    return Promise.resolve();
  });
  publish = vi
    .fn<(channel: string, raw: string) => Promise<number>>()
    .mockResolvedValue(1);
  withAbortSignal = vi.fn((signal: AbortSignal) => {
    void signal;
    return this;
  });
  destroy = vi.fn(() => {
    this.isOpen = false;
  });
}

describe('Payment event transport', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const intentId = '00000000-0000-4000-8000-000000000002';
  let publisher: FakeRedis, subscriber: FakeRedis, bus: PaymentEventsService;
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    publisher = new FakeRedis();
    subscriber = new FakeRedis();
    vi.mocked(createClient)
      .mockReturnValueOnce(publisher as never)
      .mockReturnValueOnce(subscriber as never);
    bus = new PaymentEventsService(
      new ConfigService({
        PAYMENT_REDIS_URL: 'redis://localhost:6379',
        PAYMENT_EVENTS_CHANNEL: 'test:payments',
      }),
    );
  });
  afterEach(() => {
    bus.onModuleDestroy();
  });
  it('requires no Redis when disabled and reports fallback', async () => {
    bus.onModuleDestroy();
    bus = new PaymentEventsService(
      new ConfigService({ PAYMENT_REDIS_URL: '' }),
    );
    const seen: PaymentSignal[] = [];
    const connection = bus
      .stream(userId, intentId)
      .subscribe((signal) => seen.push(signal));
    await bus.publish({ userId, intentId });
    expect(seen).toEqual([{ type: 'unavailable' }]);
    expect(createClient).not.toHaveBeenCalled();
    connection.unsubscribe();
  });
  it('routes only the matching user AND payment and ignores malformed bus frames', async () => {
    const seen: PaymentSignal[] = [];
    const connection = bus
      .stream(userId, intentId)
      .subscribe((signal) => seen.push(signal));
    await vi.waitFor(() => expect(bus.isConnected()).toBe(true));
    subscriber.listener!('not json');
    subscriber.listener!(JSON.stringify({ userId: 'bad', intentId }));
    subscriber.listener!(
      JSON.stringify({
        userId: '00000000-0000-4000-8000-000000000003',
        intentId,
      }),
    );
    subscriber.listener!(
      JSON.stringify({
        userId,
        intentId: '00000000-0000-4000-8000-000000000004',
      }),
    );
    subscriber.listener!(
      JSON.stringify({ userId, intentId, secret: 'must-not-forward' }),
    );
    expect(seen).toEqual([
      { type: 'unavailable' },
      { type: 'ready' },
      { type: 'changed', userId, intentId },
    ]);
    connection.unsubscribe();
  });
  it('uses the configured channel and a bounded command for publishing', async () => {
    await bus.publish({ userId, intentId });
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'test:payments',
      expect.any(Function),
    );
    expect(publisher.publish).toHaveBeenCalledWith(
      'test:payments',
      JSON.stringify({ userId, intentId }),
    );
    expect(publisher.withAbortSignal).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
  });
  it('fails open after a publish error and reports unavailable to streams', async () => {
    const seen: PaymentSignal[] = [];
    const connection = bus
      .stream(userId, intentId)
      .subscribe((signal) => seen.push(signal));
    await vi.waitFor(() => expect(bus.isConnected()).toBe(true));
    publisher.publish.mockRejectedValueOnce(new Error('network down'));
    await expect(bus.publish({ userId, intentId })).resolves.toBeUndefined();
    expect(bus.isConnected()).toBe(false);
    expect(seen.at(-1)).toEqual({ type: 'unavailable' });
    expect(subscriber.destroy).toHaveBeenCalled();
    connection.unsubscribe();
  });
  it('reconnects and emits ready so clients reconcile missed events', async () => {
    const seen: PaymentSignal[] = [];
    const connection = bus
      .stream(userId, intentId)
      .subscribe((signal) => seen.push(signal));
    await vi.waitFor(() => expect(bus.isConnected()).toBe(true));
    subscriber.emit('error', new Error('disconnect'));
    const nextPublisher = new FakeRedis(),
      nextSubscriber = new FakeRedis();
    vi.mocked(createClient)
      .mockReturnValueOnce(nextPublisher as never)
      .mockReturnValueOnce(nextSubscriber as never);
    await bus.publish({ userId, intentId });
    expect(bus.isConnected()).toBe(true);
    expect(seen.filter((signal) => signal.type === 'ready')).toHaveLength(2);
    connection.unsubscribe();
  });
  it('closes the transport on shutdown without accepting new connections', async () => {
    await bus.publish({ userId, intentId });
    const closed = vi.fn();
    bus.closed$.subscribe(closed);
    bus.onModuleDestroy();
    await bus.publish({ userId, intentId });
    expect(closed).toHaveBeenCalledOnce();
    expect(publisher.destroy).toHaveBeenCalledOnce();
    expect(subscriber.destroy).toHaveBeenCalledOnce();
  });
});
