import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, mongo } from 'mongoose';
import { Observable, Subject } from 'rxjs';
import { MessagingEvent, MessagingEventType } from '../mongo/models.js';

export type MessagingSignal =
  | { type: 'ready' | 'unavailable' }
  | {
      type: MessagingEventType;
      id: string;
      userIds: string[];
      conversationId: string | null;
      messageId: string | null;
      readerId: string | null;
      readSequence: number | null;
    };

type OutboxInsert = mongo.ChangeStreamInsertDocument<MessagingEvent>;

/** MongoDB change streams fan out committed outbox inserts across API instances. */
@Injectable()
export class MessagingEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingEventsService.name);
  private readonly signals = new Subject<MessagingSignal>();
  private readonly closing = new Subject<void>();
  readonly closed$ = this.closing.asObservable();
  private watcher?: mongo.ChangeStream<MessagingEvent, OutboxInsert>;
  private running?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private ready = false;

  constructor(
    @InjectModel(MessagingEvent.name)
    private readonly events: Model<MessagingEvent>,
  ) {}

  isConnected(): boolean {
    return this.ready;
  }

  stream(userId: string): Observable<MessagingSignal> {
    return new Observable((observer) => {
      const subscription = this.signals.subscribe((signal) => {
        if (!('userIds' in signal) || signal.userIds.includes(userId))
          observer.next(signal);
      });
      observer.next({ type: this.ready ? 'ready' : 'unavailable' });
      this.start();
      return () => subscription.unsubscribe();
    });
  }

  async record(
    userIds: string[],
    event: {
      type: MessagingEventType;
      conversationId?: string;
      messageId?: string;
      readerId?: string;
      readSequence?: number;
    },
    session: ClientSession,
  ): Promise<void> {
    await this.events.create([{ userIds: [...new Set(userIds)], ...event }], {
      session,
    });
  }

  private start(): void {
    if (this.stopped || this.running || this.retry) return;
    this.running = this.watch().finally(() => {
      this.running = undefined;
    });
  }

  private async watch(): Promise<void> {
    let watcher: mongo.ChangeStream<MessagingEvent, OutboxInsert> | undefined;
    try {
      // Build the collection before opening its change stream, including on an empty database.
      await this.events.init();
      watcher = this.events.collection.watch<MessagingEvent, OutboxInsert>(
        [{ $match: { operationType: 'insert' } }],
        { maxAwaitTimeMS: 1000 },
      );
      this.watcher = watcher;
      // Opening the cursor before signalling ready closes the subscribe/first-write race.
      const first = await watcher.tryNext();
      if (this.stopped) return;
      this.ready = true;
      this.signals.next({ type: 'ready' });
      if (first?.operationType === 'insert') this.emit(first.fullDocument);
      while (!this.stopped && this.watcher === watcher && !watcher.closed) {
        const change = await watcher.tryNext();
        if (change?.operationType === 'insert') this.emit(change.fullDocument);
      }
    } catch {
      if (!this.stopped)
        this.logger.warn(
          'Messaging stream unavailable; reconnect and reload conversations.',
        );
    } finally {
      if (this.watcher === watcher) this.watcher = undefined;
      this.ready = false;
      if (!this.stopped) this.signals.next({ type: 'unavailable' });
      await watcher?.close().catch(() => undefined);
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.start();
        }, 3000);
        this.retry.unref();
      }
    }
  }

  private emit(event: MessagingEvent): void {
    this.signals.next({
      type: event.type,
      id: event._id,
      userIds: event.userIds,
      conversationId: event.conversationId,
      messageId: event.messageId,
      readerId: event.readerId,
      readSequence: event.readSequence,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.closing.next();
    this.closing.complete();
    await this.watcher?.close().catch(() => undefined);
    await this.running;
    this.signals.complete();
  }
}
