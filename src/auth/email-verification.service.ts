import { Injectable } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  SendResult,
  checkResend,
  countGuess,
  generateCode,
  hashCode,
  hashesMatch,
} from './one-time-code';

export type { SendResult } from './one-time-code';

/** `locked`: the email used up its guesses for the day. */
export type VerifyResult = 'verified' | 'invalid' | 'locked';

/**
 * Six-digit email verification codes. Each user has at most one pending code;
 * sending a new one replaces it. The limits are in `one-time-code.ts`.
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
    const resend = checkResend(pending, now);
    if (!resend.allowed) return resend.reason;

    const code = generateCode();
    const data = {
      codeHash: hashCode(user.id, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      sentAt: now,
      firstSentAt: resend.firstSentAt,
      resendCount: resend.resendCount,
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
    if (!(await countGuess(this.prisma, user.email))) return 'locked';

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
    if (!hashesMatch(pending?.codeHash ?? '', hashCode(user.id, code))) {
      return 'invalid';
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: user.id,
          status: { in: [AccountStatus.PENDING_EMAIL, AccountStatus.ACTIVE] },
        },
        data: { emailVerifiedAt: new Date(), status: AccountStatus.ACTIVE },
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
}
