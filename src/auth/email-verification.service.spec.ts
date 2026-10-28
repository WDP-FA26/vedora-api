import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MailService } from '../mail/mail.service';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import { EmailVerificationService } from './email-verification.service';

const user = {
  id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  email: 'a@b.vn',
};
const PURPOSE = 'EMAIL_VERIFICATION';
const hashOf = (code: string) =>
  createHash('sha256').update(`${user.id}:${code}`).digest('hex');
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

type StoredDoc = { _id: string; [key: string]: unknown };

describe('EmailVerificationService', () => {
  let app: INestApplication;
  let db: MongoService;
  const mail = {
    sendVerificationCode: vi.fn(),
    sendPasswordResetCode: vi.fn(),
  };
  let service: EmailVerificationService;

  const codes = () => db.db.collection<StoredDoc>('one_time_codes');
  const guesses = () =>
    db.db.collection<StoredDoc>('email_verification_guesses');
  const users = () => db.db.collection<StoredDoc>('users');
  const pending = () => codes().findOne({ userId: user.id, purpose: PURPOSE });

  const seedCode = (fields: Record<string, unknown> = {}) =>
    codes().insertOne({
      _id: 'code-1',
      userId: user.id,
      purpose: PURPOSE,
      codeHash: 'a'.repeat(64),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      sentAt: secondsAgo(600),
      firstSentAt: secondsAgo(600),
      resendCount: 0,
      ...fields,
    });
  const seedUser = (fields: Record<string, unknown> = {}) =>
    users().insertOne({
      _id: user.id,
      username: 'vedora.user',
      fullName: 'Vedora User',
      email: user.email,
      role: 'USER',
      status: 'PENDING_EMAIL',
      accountVersion: 0,
      isProfessional: false,
      emailVerifiedAt: null,
      avoidedIngredientIds: [],
      avoidedGroupIds: [],
      likedIngredientIds: [],
      ...fields,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('emailverif'))],
      providers: [
        EmailVerificationService,
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(EmailVerificationService);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mail.sendVerificationCode.mockResolvedValue(undefined);
    await codes().deleteMany({});
    await guesses().deleteMany({});
    await users().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('send', () => {
    it('sends the first code, stored only as a hash, and opens a resend window', async () => {
      await expect(service.send(user)).resolves.toBe('sent');
      const [to, code] = mail.sendVerificationCode.mock.calls[0] as [
        string,
        string,
      ];
      expect(to).toBe(user.email);
      expect(code).toMatch(/^\d{6}$/);
      expect(await pending()).toMatchObject({
        resendCount: 0,
        attempts: 0,
        codeHash: hashOf(code),
      });
      expect((await pending())?.firstSentAt).toBeInstanceOf(Date);
    });

    it('waits 120 seconds between codes', async () => {
      await seedCode({ sentAt: secondsAgo(119) });

      await expect(service.send(user)).resolves.toBe('cooldown');
      expect(mail.sendVerificationCode).not.toHaveBeenCalled();
    });

    it('counts a resend once the cooldown has passed', async () => {
      const firstSentAt = secondsAgo(600);
      await seedCode({
        sentAt: secondsAgo(130),
        firstSentAt,
        resendCount: 1,
      });

      await expect(service.send(user)).resolves.toBe('sent');
      expect(await pending()).toMatchObject({ resendCount: 2, firstSentAt });
    });

    it('stops after three resends within the hour', async () => {
      await seedCode({ resendCount: 3 });

      await expect(service.send(user)).resolves.toBe('limit');
      expect(mail.sendVerificationCode).not.toHaveBeenCalled();
    });

    it('allows resends again once the hour is over', async () => {
      await seedCode({ firstSentAt: secondsAgo(3601), resendCount: 3 });

      await expect(service.send(user)).resolves.toBe('sent');
      const stored = await pending();
      expect(stored).toMatchObject({ resendCount: 0 });
      expect((stored?.firstSentAt as Date).getTime()).toBeGreaterThan(
        secondsAgo(60).getTime(),
      );
    });

    it('restores the previous code when the email fails', async () => {
      const before = {
        sentAt: secondsAgo(600),
        firstSentAt: secondsAgo(600),
        resendCount: 1,
        codeHash: 'b'.repeat(64),
      };
      await seedCode(before);
      mail.sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

      await expect(service.send(user)).rejects.toThrow('Resend is down');
      expect(await pending()).toMatchObject(before);
    });

    it('drops a first code whose email failed', async () => {
      mail.sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

      await expect(service.send(user)).rejects.toThrow('Resend is down');
      expect(await pending()).toBeNull();
    });
  });

  describe('verify', () => {
    beforeEach(async () => {
      await seedUser();
      await seedCode({ codeHash: hashOf('123456') });
    });

    it('verifies a matching code and marks the email verified', async () => {
      await expect(service.verify(user, '123456')).resolves.toBe('verified');
      expect(await users().findOne({ _id: user.id })).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        (await users().findOne({ _id: user.id }))?.emailVerifiedAt,
      ).toBeInstanceOf(Date);
      expect(await pending()).toBeNull();
      expect(await guesses().countDocuments()).toBe(0);
    });

    it('rejects a wrong code without changing the account', async () => {
      await expect(service.verify(user, '654321')).resolves.toBe('invalid');
      expect(await users().findOne({ _id: user.id })).toMatchObject({
        status: 'PENDING_EMAIL',
        emailVerifiedAt: null,
      });
      expect(await pending()).toMatchObject({ attempts: 1 });
    });

    it('counts every guess against the email, capped at 15 a day', async () => {
      await service.verify(user, '654321');

      expect(await guesses().findOne({ _id: user.email })).toMatchObject({
        guesses: 1,
      });
    });

    it('locks the email once its guesses are used up, even with a fresh code', async () => {
      await guesses().insertOne({
        _id: user.email,
        guesses: 15,
        windowStart: new Date(),
      });

      await expect(service.verify(user, '123456')).resolves.toBe('locked');
      expect(await pending()).toMatchObject({ attempts: 0 });
    });

    it('rejects expired codes before comparing', async () => {
      await codes().updateOne(
        { userId: user.id, purpose: PURPOSE },
        { $set: { expiresAt: secondsAgo(1) } },
      );

      await expect(service.verify(user, '123456')).resolves.toBe('invalid');
      expect(await pending()).toMatchObject({ attempts: 0 });
    });

    it('rejects codes that used up their attempts', async () => {
      await codes().updateOne(
        { userId: user.id, purpose: PURPOSE },
        { $set: { attempts: 5 } },
      );

      await expect(service.verify(user, '123456')).resolves.toBe('invalid');
    });

    it('answers 404 when the account disappeared', async () => {
      await users().deleteMany({});

      await expect(service.verify(user, '123456')).rejects.toMatchObject({
        status: 404,
      });
      expect(await pending()).not.toBeNull();
    });
  });
});
