import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  AccountStatus,
  EmailVerificationGuesses,
  OneTimeCode,
  OneTimeCodePurpose,
  User,
} from '../mongo/models.js';
import { MailService } from '../mail/mail.service.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  SendResult,
  checkResend,
  codeKey,
  countGuess,
  generateCode,
  hashCode,
  hashesMatch,
} from './one-time-code.js';

/** `locked`: the email used up its guesses for the day. */
export type ResetResult = 'reset' | 'invalid' | 'locked';

/**
 * Six-digit "forgot password" codes, with the same limits as verification
 * codes (`one-time-code.ts`). Their guesses count against the same per-email
 * budget, so switching between the two flows doesn't buy more guesses.
 */
const PURPOSE = OneTimeCodePurpose.PASSWORD_RESET;

@Injectable()
export class PasswordResetService {
  constructor(
    @InjectModel(OneTimeCode.name) private readonly codes: Model<OneTimeCode>,
    @InjectModel(EmailVerificationGuesses.name)
    private readonly guesses: Model<EmailVerificationGuesses>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Emails a fresh code when the cooldown and resend limit allow it. If the
   * email can't be sent, the previous state is restored so the failed attempt
   * doesn't cost the user a resend.
   */
  async send(user: { id: string; email: string }): Promise<SendResult> {
    const now = new Date();
    const pending = await this.codes.findOne(codeKey(user.id, PURPOSE)).exec();
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
    await this.codes.findOneAndUpdate(
      codeKey(user.id, PURPOSE),
      {
        $set: data,
        $setOnInsert: { userId: user.id, purpose: PURPOSE },
      },
      { upsert: true, returnDocument: 'after' },
    );

    try {
      await this.mailService.sendPasswordResetCode(user.email, code);
    } catch (error) {
      if (pending) {
        await this.codes.updateOne(codeKey(user.id, PURPOSE), {
          $set: {
            codeHash: pending.codeHash,
            attempts: pending.attempts,
            expiresAt: pending.expiresAt,
            sentAt: pending.sentAt,
            firstSentAt: pending.firstSentAt,
            resendCount: pending.resendCount,
          },
        });
      } else {
        await this.codes.deleteOne(codeKey(user.id, PURPOSE));
      }
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
    if (!(await countGuess(this.guesses, user.email))) return 'locked';

    // Count the attempt before comparing, so parallel guesses can't exceed the cap.
    const counted = await this.codes.updateOne(
      {
        ...codeKey(user.id, PURPOSE),
        attempts: { $lt: MAX_ATTEMPTS },
        expiresAt: { $gt: new Date() },
      },
      { $inc: { attempts: 1 } },
    );
    if (counted.modifiedCount !== 1) return 'invalid';

    const pending = await this.codes.findOne(codeKey(user.id, PURPOSE)).exec();
    const codeHash = pending?.codeHash ?? '';
    if (!hashesMatch(codeHash, this.hash(user.id, code))) return 'invalid';

    // Deleting the code by its hash makes it single use: of two parallel
    // resets with the right code, only one gets to change the password.
    const applied = await this.mongo.withTransaction(async (session) => {
      const used = await this.codes.deleteOne(
        { userId: user.id, purpose: PURPOSE, codeHash },
        { session },
      );
      if (used.deletedCount !== 1) return false;
      const now = new Date();
      const updated = await this.users.updateOne(
        { _id: user.id },
        {
          $set: {
            passwordHash,
            emailVerifiedAt: user.emailVerifiedAt ?? now,
          },
        },
        { session },
      );
      if (updated.matchedCount !== 1) return false;
      // Email ownership can activate a pending signup, never a suspension.
      await this.users.updateOne(
        { _id: user.id, status: AccountStatus.PENDING_EMAIL },
        { $set: { status: AccountStatus.ACTIVE } },
        { session },
      );
      // The pending verification code is moot now.
      await this.codes.deleteMany({ userId: user.id }, { session });
      await this.guesses.deleteOne({ _id: user.email }, { session });
      return true;
    });
    return applied ? 'reset' : 'invalid';
  }

  /** Reset codes hash differently, so a verification code can't pass for one. */
  private hash(userId: string, code: string): string {
    return hashCode(`password-reset:${userId}`, code);
  }
}
