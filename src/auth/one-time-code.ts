import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

// Rules shared by the six-digit codes we email: verification and password
// reset. Guesses are capped per code and per email per day (15 in 10^6), and
// new codes are limited to one every two minutes and three resends an hour,
// so neither brute-forcing a code nor flooding an inbox is practical.

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 120 * 1000;
/** New codes allowed after the first one, per window. */
export const MAX_RESENDS = 3;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Guesses per email across all its codes, so fresh codes don't buy more. */
const MAX_GUESSES_PER_EMAIL = 15;
const GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `sent`, or why no email went out. */
export type SendResult = 'sent' | 'cooldown' | 'limit';

/** The send bookkeeping of a pending code. */
export type PendingCode = {
  sentAt: Date;
  firstSentAt: Date;
  resendCount: number;
};

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** SHA-256 hex of `code`, bound to `scope` so one code can't pass as another. */
export function hashCode(scope: string, code: string): string {
  return createHash('sha256').update(`${scope}:${code}`).digest('hex');
}

export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Whether a new code may go out now, and the resend window it falls in. */
export function checkResend(
  pending: PendingCode | null,
  now: Date,
):
  | { allowed: false; reason: 'cooldown' | 'limit' }
  | { allowed: true; firstSentAt: Date; resendCount: number } {
  const inWindow =
    pending !== null &&
    now.getTime() - pending.firstSentAt.getTime() < RESEND_WINDOW_MS;
  if (!inWindow) return { allowed: true, firstSentAt: now, resendCount: 0 };
  if (now.getTime() - pending.sentAt.getTime() < RESEND_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown' };
  }
  if (pending.resendCount >= MAX_RESENDS) {
    return { allowed: false, reason: 'limit' };
  }
  return {
    allowed: true,
    firstSentAt: pending.firstSentAt,
    resendCount: pending.resendCount + 1,
  };
}

/**
 * Uses up one of the email's guesses for the day. Each step is a single
 * conditional write, so parallel guesses can't slip past the cap.
 */
export async function countGuess(
  prisma: PrismaService,
  email: string,
): Promise<boolean> {
  const now = new Date();
  await prisma.emailVerificationGuesses.createMany({
    data: [{ email, windowStart: now }],
    skipDuplicates: true,
  });
  await prisma.emailVerificationGuesses.updateMany({
    where: {
      email,
      windowStart: { lte: new Date(now.getTime() - GUESS_WINDOW_MS) },
    },
    data: { guesses: 0, windowStart: now },
  });
  const counted = await prisma.emailVerificationGuesses.updateMany({
    where: { email, guesses: { lt: MAX_GUESSES_PER_EMAIL } },
    data: { guesses: { increment: 1 } },
  });
  return counted.count === 1;
}
