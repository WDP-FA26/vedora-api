import { Injectable } from '@nestjs/common';
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

/** `locked`: the email used up its guesses for the day. */
export type ResetResult = 'reset' | 'invalid' | 'locked';

/**
 * Six-digit "forgot password" codes, with the same limits as verification
 * codes (`one-time-code.ts`). Their guesses count against the same per-email
 * budget, so switching between the two flows doesn't buy more guesses.
 */
@Injectable()
export class PasswordResetService {
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
    const pending = await this.prisma.passwordResetCode.findUnique({
      where: { userId: user.id },
    });
    const resend = checkResend(pending, now);
    if (!resend.allowed) return resend.reason;

    const code = generateCode();
    const data = {
      codeHash: this.hash(user.id, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      sentAt: now,
      firstSentAt: resend.firstSentAt,
      resendCount: resend.resendCount,
    };
    await this.prisma.passwordResetCode.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });

    try {
      await this.mailService.sendPasswordResetCode(user.email, code);
    } catch (error) {
      await (pending
        ? this.prisma.passwordResetCode.update({
            where: { userId: user.id },
            data: pending,
          })
        : this.prisma.passwordResetCode.deleteMany({
            where: { userId: user.id },
          }));
      throw error;
    }
    return 'sent';
  }

  /**
   * Checks `code` and, when it matches, replaces the password with
   * `passwordHash`. Receiving the code proves the user owns the email, so an
   * unverified account is verified on the way.
   */
  async reset(
    user: { id: string; email: string; emailVerifiedAt: Date | null },
    code: string,
    passwordHash: string,
  ): Promise<ResetResult> {
    if (!(await countGuess(this.prisma, user.email))) return 'locked';

    // Count the attempt before comparing, so parallel guesses can't exceed the cap.
    const counted = await this.prisma.passwordResetCode.updateMany({
      where: {
        userId: user.id,
        attempts: { lt: MAX_ATTEMPTS },
        expiresAt: { gt: new Date() },
      },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) return 'invalid';

    const pending = await this.prisma.passwordResetCode.findUnique({
      where: { userId: user.id },
    });
    const codeHash = pending?.codeHash ?? '';
    if (!hashesMatch(codeHash, this.hash(user.id, code))) return 'invalid';

    // Deleting the code by its hash makes it single use: of two parallel
    // resets with the right code, only one gets to change the password.
    const applied = await this.prisma.$transaction(async (tx) => {
      const used = await tx.passwordResetCode.deleteMany({
        where: { userId: user.id, codeHash },
      });
      if (used.count !== 1) return false;
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      await tx.emailVerificationCode.deleteMany({ where: { userId: user.id } });
      await tx.emailVerificationGuesses.deleteMany({
        where: { email: user.email },
      });
      return true;
    });
    return applied ? 'reset' : 'invalid';
  }

  /** Reset codes hash differently, so a verification code can't pass for one. */
  private hash(userId: string, code: string): string {
    return hashCode(`password-reset:${userId}`, code);
  }
}
