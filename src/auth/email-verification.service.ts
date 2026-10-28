import { Injectable, NotFoundException } from '@nestjs/common';
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

export type { SendResult } from './one-time-code.js';

/** `locked`: the email used up its guesses for the day. */
export type VerifyResult = 'verified' | 'invalid' | 'locked';

/**
 * Six-digit email verification codes. Each user has at most one pending code;
 * sending a new one replaces it. The limits are in `one-time-code.ts`.
 */
const PURPOSE = OneTimeCodePurpose.EMAIL_VERIFICATION;

@Injectable()
export class EmailVerificationService {
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
      codeHash: hashCode(user.id, code),
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
      await this.mailService.sendVerificationCode(user.email, code);
    } catch (error) {
      if (pending) {
        await this.codes.updateOne(codeKey(user.id, PURPOSE), {
          $set: {
            sentAt: pending.sentAt,
            firstSentAt: pending.firstSentAt,
            resendCount: pending.resendCount,
            codeHash: pending.codeHash,
            attempts: pending.attempts,
            expiresAt: pending.expiresAt,
          },
        });
      } else {
        await this.discard(user.id);
      }
      throw error;
    }
    return 'sent';
  }

  /** Checks `code` and, when it matches, marks the email verified. */
  async verify(
    user: { id: string; email: string },
    code: string,
  ): Promise<VerifyResult> {
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
    if (!hashesMatch(pending?.codeHash ?? '', hashCode(user.id, code))) {
      return 'invalid';
    }

    await this.mongo.withTransaction(async (session) => {
      const now = new Date();
      const verified = await this.users.updateOne(
        {
          _id: user.id,
          status: {
            $in: [AccountStatus.PENDING_EMAIL, AccountStatus.ACTIVE],
          },
        },
        {
          $set: {
            emailVerifiedAt: now,
            status: AccountStatus.ACTIVE,
          },
        },
        { session },
      );
      if (verified.matchedCount !== 1) {
        throw new NotFoundException('Account not found');
      }
      await this.codes.deleteOne(codeKey(user.id, PURPOSE), { session });
      await this.guesses.deleteOne({ _id: user.email }, { session });
    });
    return 'verified';
  }

  async discard(userId: string): Promise<void> {
    await this.codes.deleteMany({ userId, purpose: PURPOSE });
  }
}
