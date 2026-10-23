import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { Observable, Subject } from 'rxjs';
import { z } from 'zod';

const changedSchema = z.object({ userId: z.uuid(), intentId: z.uuid() });
export type PaymentChanged = z.infer<typeof changedSchema>;
export type PaymentSignal =
  { type: 'ready' | 'unavailable' } | ({ type: 'changed' } & PaymentChanged);
type Client = ReturnType<typeof createClient>;
type Pair = { publisher: Client; subscriber: Client };

/** Database-independent, best-effort invalidation bus. Never stores payment state. */
@Injectable()
export class PaymentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventsService.name);
  private readonly signals = new Subject<PaymentSignal>();
  private readonly closing = new Subject<void>();
  readonly closed$ = this.closing.asObservable();
  private pair?: Pair;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private ready = false;
  private readonly channel: string;

  constructor(private readonly config: ConfigService) {
    this.channel = config.get<string>(
      'PAYMENT_EVENTS_CHANNEL',
      'vedora:payments:v1',
    );
  }

  isConnected(): boolean {
    return this.ready;
  }

  stream(userId: string, intentId: string): Observable<PaymentSignal> {
    return new Observable((observer) => {
      const subscription = this.signals.subscribe((signal) => {
        if (
          signal.type !== 'changed' ||
          (signal.userId === userId && signal.intentId === intentId)
        )
          observer.next(signal);
      });
      observer.next({ type: this.ready ? 'ready' : 'unavailable' });
      void this.connect();
      return () => subscription.unsubscribe();
    });
  }

  /** Called only after the domain transaction resolves; failures cannot undo payment. */
  async publish(event: PaymentChanged): Promise<void> {
    if (!this.config.get<string>('PAYMENT_REDIS_URL', '') || this.stopped)
      return;
    try {
      await this.connect();
      const pair = this.pair;
      if (!this.ready || !pair) return;
      await pair.publisher
        .withAbortSignal(AbortSignal.timeout(1000))
        .publish(this.channel, JSON.stringify(event));
    } catch {
      if (this.pair) this.disconnect(this.pair);
      this.logger.warn(
        'Payment committed; realtime publish unavailable. GET reconciliation remains available.',
      );
    }
  }

  private connect(): Promise<void> {
    if (this.stopped || this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = this.config.get<string>('PAYMENT_REDIS_URL', '');
    if (!url) return Promise.resolve();
    this.connecting = this.open(url).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(url: string): Promise<void> {
    const options = {
      url,
      socket: { connectTimeout: 1500, reconnectStrategy: false as const },
      disableOfflineQueue: true,
    };
    const pair: Pair = {
      publisher: createClient(options),
      subscriber: createClient(options),
    };
    this.pair = pair;
    for (const client of [pair.publisher, pair.subscriber]) {
      client.on('error', () => this.disconnect(pair));
      client.on('end', () => this.disconnect(pair));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all([
            pair.publisher.connect(),
            pair.subscriber.connect(),
          ]);
          await pair.subscriber.subscribe(this.channel, (raw) => {
            try {
              const parsed = changedSchema.safeParse(JSON.parse(raw));
              if (parsed.success && this.pair === pair && !this.stopped)
                this.signals.next({ type: 'changed', ...parsed.data });
            } catch {
              /* Ignore malformed bus data; no payload is logged. */
            }
          });
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Realtime connect timeout')),
            2000,
          );
        }),
      ]);
      if (this.stopped || this.pair !== pair) return;
      this.ready = true;
      this.signals.next({ type: 'ready' });
    } catch {
      this.disconnect(pair);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private disconnect(pair: Pair): void {
    if (this.pair !== pair) return;
    this.pair = undefined;
    this.ready = false;
    this.signals.next({ type: 'unavailable' });
    for (const client of [pair.publisher, pair.subscriber]) {
      if (client.isOpen) client.destroy();
    }
    if (!this.stopped && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.connect();
      }, 3000);
      this.retry.unref();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.closing.next();
    this.closing.complete();
    if (this.retry) clearTimeout(this.retry);
    if (this.pair) this.disconnect(this.pair);
    this.signals.complete();
  }
}
