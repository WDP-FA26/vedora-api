import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type QuotaVerdict = 'ok' | 'guest' | 'ip' | 'budget';

/**
 * Daily caps on guest messages: per guest session, per IP address (a cleared
 * browser gets a new session, not a new address; the cap is higher because
 * homes, schools and mobile carriers share addresses) and across all guests,
 * which bounds what the public chat can cost in a day. Counters live in this
 * process and reset at midnight UTC; move them to Redis to share instances.
 */
@Injectable()
export class GuestQuotaService {
  private readonly perGuest: number;
  private readonly perIp: number;
  private readonly budget: number;

  private day = today();
  private total = 0;
  private readonly counts = new Map<string, number>();

  constructor(configService: ConfigService) {
    this.perGuest = configService.get<number>('GUEST_DAILY_MESSAGES', 5);
    this.perIp = configService.get<number>('GUEST_DAILY_MESSAGES_PER_IP', 20);
    this.budget = configService.get<number>('GUEST_DAILY_BUDGET', 500);
  }

  /** Counts one message, unless a cap is already reached. */
  consume(guestId: string, ip: string): QuotaVerdict {
    this.rollOver();
    const guestKey = `guest:${guestId}`;
    const ipKey = `ip:${ip}`;
    if (this.total >= this.budget) return 'budget';
    if (this.count(guestKey) >= this.perGuest) return 'guest';
    if (this.count(ipKey) >= this.perIp) return 'ip';

    this.total += 1;
    this.counts.set(guestKey, this.count(guestKey) + 1);
    this.counts.set(ipKey, this.count(ipKey) + 1);
    return 'ok';
  }

  remaining(guestId: string, ip: string): number {
    this.rollOver();
    return Math.max(
      0,
      Math.min(
        this.perGuest - this.count(`guest:${guestId}`),
        this.perIp - this.count(`ip:${ip}`),
        this.budget - this.total,
      ),
    );
  }

  private count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  private rollOver(): void {
    if (this.day === today()) return;
    this.day = today();
    this.total = 0;
    this.counts.clear();
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
