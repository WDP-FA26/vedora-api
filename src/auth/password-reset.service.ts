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

export type ResetResult = 'reset' | 'invalid' | 'locked';

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

  async reset(
    user: { id: string; email: string; emailVerifiedAt: Date | null },
    code: string,
    passwordHash: string,
  ): Promise<ResetResult> {
    if (!(await countGuess(this.guesses, user.email))) return 'locked';

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
      await this.users.updateOne(
        { _id: user.id, status: AccountStatus.PENDING_EMAIL },
        { $set: { status: AccountStatus.ACTIVE } },
        { session },
      );
      await this.codes.deleteMany({ userId: user.id }, { session });
      await this.guesses.deleteOne({ _id: user.email }, { session });
      return true;
    });
    return applied ? 'reset' : 'invalid';
  }

  private hash(userId: string, code: string): string {
    return hashCode(`password-reset:${userId}`, code);
  }
}
