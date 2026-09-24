import { Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 120 * 1000;
/** New codes allowed after the first one, per window. */
const MAX_RESENDS = 3;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Guesses per email across all its codes, so fresh codes don't buy more. */
const MAX_GUESSES_PER_EMAIL = 15;
const GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `sent`, or why no email went out. */
export type SendResult = 'sent' | 'cooldown' | 'limit';

/** `locked`: the email used up its guesses for the day. */
export type VerifyResult = 'verified' | 'invalid' | 'locked';

/**
 * Six-digit email codes. Each user has at most one pending code; sending a new
 * one replaces it. Guesses are capped per code and per email per day (15 in
 * 10^6), and new codes are limited to one every two minutes and three resends
 * an hour, so neither brute-forcing a code nor flooding an inbox is practical.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Emails a fresh code when the cooldown and resend limit allow it. If the
   * email can't be sent, the previous state is restored so the failed attempt
   * doesn't cost the user a resend.
   */
  async send(user: { id: string; email: string }): Promise<SendResult> {
    const now = new Date();
    const pending = await this.prisma.emailVerificationCode.findUnique({
      where: { userId: user.id },
    });
    const inWindow =
      pending !== null &&
      now.getTime() - pending.firstSentAt.getTime() < RESEND_WINDOW_MS;
    if (inWindow) {
      if (now.getTime() - pending.sentAt.getTime() < RESEND_COOLDOWN_MS) {
        return 'cooldown';
      }
      if (pending.resendCount >= MAX_RESENDS) return 'limit';
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const data = {
      codeHash: this.hashCode(user.id, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      sentAt: now,
      firstSentAt: inWindow ? pending.firstSentAt : now,
      resendCount: inWindow ? pending.resendCount + 1 : 0,
    };
    await this.prisma.emailVerificationCode.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });

    try {
      await this.mailService.sendVerificationCode(user.email, code);
    } catch (error) {
      await (pending
        ? this.prisma.emailVerificationCode.update({
            where: { userId: user.id },
            data: pending,
          })
        : this.discard(user.id));
      throw error;
    }
    return 'sent';
  }

  /** Checks `code` and, when it matches, marks the email verified. */
  async verify(
    user: { id: string; email: string },
    code: string,
  ): Promise<VerifyResult> {
    if (!(await this.countGuess(user.email))) return 'locked';

    // Count the attempt before comparing, so parallel guesses can't exceed the cap.
    const counted = await this.prisma.emailVerificationCode.updateMany({
      where: {
        userId: user.id,
        attempts: { lt: MAX_ATTEMPTS },
        expiresAt: { gt: new Date() },
      },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) return 'invalid';

    const pending = await this.prisma.emailVerificationCode.findUnique({
      where: { userId: user.id },
    });
    const expected = Buffer.from(pending?.codeHash ?? '', 'hex');
    const actual = Buffer.from(this.hashCode(user.id, code), 'hex');
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return 'invalid';
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.emailVerificationCode.delete({ where: { userId: user.id } }),
      this.prisma.emailVerificationGuesses.deleteMany({
        where: { email: user.email },
      }),
    ]);
    return 'verified';
  }

  async discard(userId: string): Promise<void> {
    await this.prisma.emailVerificationCode.deleteMany({ where: { userId } });
  }

  /**
   * Uses up one of the email's guesses for the day. Each step is a single
   * conditional write, so parallel guesses can't slip past the cap.
   */
  private async countGuess(email: string): Promise<boolean> {
    const now = new Date();
    await this.prisma.emailVerificationGuesses.createMany({
      data: [{ email, windowStart: now }],
      skipDuplicates: true,
    });
    await this.prisma.emailVerificationGuesses.updateMany({
      where: {
        email,
        windowStart: { lte: new Date(now.getTime() - GUESS_WINDOW_MS) },
      },
      data: { guesses: 0, windowStart: now },
    });
    const counted = await this.prisma.emailVerificationGuesses.updateMany({
      where: { email, guesses: { lt: MAX_GUESSES_PER_EMAIL } },
      data: { guesses: { increment: 1 } },
    });
    return counted.count === 1;
  }

  private hashCode(userId: string, code: string): string {
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }
}
