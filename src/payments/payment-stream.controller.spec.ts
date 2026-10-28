import { MessageEvent } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Subject } from 'rxjs';
import type { Model } from 'mongoose';
import type { AuthenticatedRequest } from '../auth/auth.types';
import type { User } from '../mongo/models';
import { PaymentEventsService, PaymentSignal } from './payment-events.service';
import { PaymentsService } from './payments.service';
import { PaymentStreamController } from './payment-stream.controller';

describe('Payment stream lifecycle', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const id = '00000000-0000-4000-8000-000000000002';
  const req = {
    user: { sub: userId, username: 'member', role: 'USER' },
    headers: { authorization: 'Bearer private-jwt' },
  } as AuthenticatedRequest;
  let signals: Subject<PaymentSignal>, closed: Subject<void>;
  let get: ReturnType<typeof vi.fn>,
    verify: ReturnType<typeof vi.fn>,
    findUser: ReturnType<typeof vi.fn>;
  let controller: PaymentStreamController;
  beforeEach(() => {
    vi.useFakeTimers();
    signals = new Subject();
    closed = new Subject();
    get = vi.fn().mockResolvedValue({ id });
    verify = vi.fn().mockResolvedValue({ sub: userId });
    findUser = vi.fn().mockResolvedValue({ status: 'ACTIVE' });
    controller = new PaymentStreamController(
      { get } as unknown as PaymentsService,
      {
        stream: () => signals.asObservable(),
        isConnected: () => true,
        closed$: closed.asObservable(),
      } as unknown as PaymentEventsService,
      {
        findById: () => ({ select: () => ({ exec: findUser }) }),
      } as unknown as Model<User>,
      { verifyAsync: verify } as unknown as JwtService,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('checks ownership before allocating the live stream', async () => {
    get.mockRejectedValueOnce(new Error('not owned'));
    await expect(controller.stream(id, req)).rejects.toThrow('not owned');
    expect(get).toHaveBeenCalledWith(id, userId);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends invalidation IDs without owner or JWT data and cleans up timers on disconnect', async () => {
    const seen: MessageEvent[] = [];
    const subscription = (await controller.stream(id, req)).subscribe((event) =>
      seen.push(event),
    );
    signals.next({ type: 'ready' });
    signals.next({ type: 'changed', userId, intentId: id });
    await vi.advanceTimersByTimeAsync(15000);
    expect(seen).toEqual([
      { type: 'stream.ready', data: {} },
      { type: 'payment.changed', data: { intentId: id } },
      { type: 'ping', data: { connected: true } },
    ]);
    expect(JSON.stringify(seen)).not.toContain(userId);
    expect(JSON.stringify(seen)).not.toContain('private-jwt');
    subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes after JWT expiration so the client refreshes its session', async () => {
    verify.mockRejectedValueOnce(new Error('expired'));
    const seen: MessageEvent[] = [],
      completed = vi.fn();
    (await controller.stream(id, req)).subscribe({
      next: (event) => seen.push(event),
      complete: completed,
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(seen.at(-1)?.type).toBe('session.expired');
    expect(completed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a suspended or deleted account stream', async () => {
    findUser.mockResolvedValueOnce({ status: 'SUSPENDED' });
    const seen: MessageEvent[] = [],
      completed = vi.fn();
    (await controller.stream(id, req)).subscribe({
      next: (event) => seen.push(event),
      complete: completed,
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(seen.at(-1)?.type).toBe('session.expired');
    expect(completed).toHaveBeenCalledOnce();
  });
  it('reports fallback on database outage without claiming the session is invalid', async () => {
    findUser.mockRejectedValueOnce(new Error('DB unavailable'));
    const seen: MessageEvent[] = [];
    const subscription = (await controller.stream(id, req)).subscribe((event) =>
      seen.push(event),
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(seen.at(-1)?.type).toBe('stream.unavailable');
    subscription.unsubscribe();
  });
  it('closes on app shutdown and releases its heartbeat', async () => {
    const completed = vi.fn();
    (await controller.stream(id, req)).subscribe({ complete: completed });
    closed.next();
    expect(completed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
