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
import { PasswordResetService } from './password-reset.service';

const user = {
  id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  email: 'a@b.vn',
  emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
};
const PURPOSE = 'PASSWORD_RESET';
const hashOf = (code: string) =>
  createHash('sha256')
    .update(`password-reset:${user.id}:${code}`)
    .digest('hex');
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

type StoredDoc = { _id: string; [key: string]: unknown };

describe('PasswordResetService', () => {
  let app: INestApplication;
  let db: MongoService;
  const mail = {
    sendVerificationCode: vi.fn(),
    sendPasswordResetCode: vi.fn(),
  };
  let service: PasswordResetService;

  const codes = () => db.db.collection<StoredDoc>('one_time_codes');
  const guesses = () =>
    db.db.collection<StoredDoc>('email_verification_guesses');
  const users = () => db.db.collection<StoredDoc>('users');
  const pending = () => codes().findOne({ userId: user.id, purpose: PURPOSE });
  const storedUser = () => users().findOne({ _id: user.id });

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
      status: 'ACTIVE',
      accountVersion: 0,
      isProfessional: false,
      emailVerifiedAt: user.emailVerifiedAt,
      avoidedIngredientIds: [],
      avoidedGroupIds: [],
      likedIngredientIds: [],
      ...fields,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('pwreset'))],
      providers: [
        PasswordResetService,
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PasswordResetService);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mail.sendPasswordResetCode.mockResolvedValue(undefined);
    await codes().deleteMany({});
    await guesses().deleteMany({});
    await users().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('send', () => {
    it('emails a six-digit code and stores only its hash', async () => {
      await expect(service.send(user)).resolves.toBe('sent');
      const [to, code] = mail.sendPasswordResetCode.mock.calls[0] as [
        string,
        string,
      ];
      expect(to).toBe(user.email);
      expect(code).toMatch(/^\d{6}$/);
      const stored = await pending();
      expect(stored).toMatchObject({ resendCount: 0, codeHash: hashOf(code) });
      expect(stored?.codeHash).not.toContain(code);
      expect(mail.sendVerificationCode).not.toHaveBeenCalled();
    });

    it('waits 120 seconds between codes', async () => {
      await seedCode({ sentAt: secondsAgo(119) });

      await expect(service.send(user)).resolves.toBe('cooldown');
      expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('stops after three resends within the hour', async () => {
      await seedCode({ resendCount: 3 });

      await expect(service.send(user)).resolves.toBe('limit');
      expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('restores the previous code when the email fails', async () => {
      const before = {
        codeHash: 'b'.repeat(64),
        sentAt: secondsAgo(600),
        firstSentAt: secondsAgo(600),
        resendCount: 1,
      };
      await seedCode(before);
      mail.sendPasswordResetCode.mockRejectedValue(new Error('Resend is down'));

      await expect(service.send(user)).rejects.toThrow('Resend is down');
      expect(await pending()).toMatchObject(before);
    });
  });

  describe('reset', () => {
    beforeEach(async () => {
      await seedUser();
      await seedCode({ codeHash: hashOf('123456') });
    });

    it('replaces the password with a matching code and uses the code up', async () => {
      await expect(service.reset(user, '123456', 'new-hash')).resolves.toBe(
        'reset',
      );
      expect(await storedUser()).toMatchObject({ passwordHash: 'new-hash' });
      expect(await pending()).toBeNull();
    });

    it('verifies an unverified email on the way', async () => {
      await expect(
        service.reset({ ...user, emailVerifiedAt: null }, '123456', 'new-hash'),
      ).resolves.toBe('reset');
      const stored = await storedUser();
      expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(stored).toMatchObject({ status: 'ACTIVE' });
    });

    it('never reactivates a suspended account', async () => {
      await users().updateOne(
        { _id: user.id },
        { $set: { status: 'SUSPENDED' } },
      );

      await expect(service.reset(user, '123456', 'new-hash')).resolves.toBe(
        'reset',
      );
      expect(await storedUser()).toMatchObject({ status: 'SUSPENDED' });
    });

    it('rejects a wrong code without changing the password', async () => {
      await expect(service.reset(user, '654321', 'h')).resolves.toBe('invalid');
      expect((await storedUser())?.passwordHash ?? null).toBeNull();
    });

    it('does not accept the matching email verification code', async () => {
      await codes().updateOne(
        { userId: user.id, purpose: PURPOSE },
        {
          $set: {
            codeHash: createHash('sha256')
              .update(`${user.id}:123456`)
              .digest('hex'),
          },
        },
      );

      await expect(service.reset(user, '123456', 'h')).resolves.toBe('invalid');
    });

    it('rejects expired or exhausted codes before comparing', async () => {
      await codes().updateOne(
        { userId: user.id, purpose: PURPOSE },
        { $set: { expiresAt: secondsAgo(1) } },
      );

      await expect(service.reset(user, '123456', 'h')).resolves.toBe('invalid');
      expect(await pending()).toMatchObject({ attempts: 0 });
    });

    it('lets only one of two parallel resets with the right code win', async () => {
      const results = await Promise.all([
        service.reset(user, '123456', 'hash-a'),
        service.reset(user, '123456', 'hash-b'),
      ]);

      expect(results.sort()).toEqual(['invalid', 'reset']);
    });

    it('shares the per-email guess budget with verification codes', async () => {
      await guesses().insertOne({
        _id: user.email,
        guesses: 15,
        windowStart: new Date(),
      });

      await expect(service.reset(user, '123456', 'h')).resolves.toBe('locked');
      expect(await pending()).toMatchObject({ attempts: 0 });
    });

    it('clears the remaining codes and guesses of the account', async () => {
      await codes().insertOne({
        _id: 'code-2',
        userId: user.id,
        purpose: 'EMAIL_VERIFICATION',
        codeHash: 'c'.repeat(64),
        attempts: 0,
        expiresAt: new Date(Date.now() + 600_000),
        sentAt: new Date(),
        firstSentAt: new Date(),
        resendCount: 0,
      });
      await guesses().insertOne({
        _id: user.email,
        guesses: 2,
        windowStart: new Date(),
      });

      await service.reset(user, '123456', 'h');

      expect(await codes().countDocuments()).toBe(0);
      expect(await guesses().countDocuments()).toBe(0);
    });
  });
});
