import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Model } from 'mongoose';
import {
  EmailVerificationGuesses,
  OneTimeCodePurpose,
} from '../mongo/models.js';
import { isUniqueViolation } from '../mongo/errors.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 120 * 1000;
export const MAX_RESENDS = 3;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
const MAX_GUESSES_PER_EMAIL = 15;
const GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SendResult = 'sent' | 'cooldown' | 'limit';

export type PendingCode = {
  sentAt: Date;
  firstSentAt: Date;
  resendCount: number;
};

export const codeKey = (userId: string, purpose: OneTimeCodePurpose) => ({
  userId,
  purpose,
});

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashCode(scope: string, code: string): string {
  return createHash('sha256').update(`${scope}:${code}`).digest('hex');
}

export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

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

export async function countGuess(
  guesses: Model<EmailVerificationGuesses>,
  email: string,
): Promise<boolean> {
  const now = new Date();
  try {
    await guesses.create({ _id: email, guesses: 0, windowStart: now });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await guesses.updateOne(
    {
      _id: email,
      windowStart: { $lte: new Date(now.getTime() - GUESS_WINDOW_MS) },
    },
    { $set: { guesses: 0, windowStart: now } },
  );
  const counted = await guesses.updateOne(
    { _id: email, guesses: { $lt: MAX_GUESSES_PER_EMAIL } },
    { $inc: { guesses: 1 } },
  );
  return counted.modifiedCount === 1;
}
