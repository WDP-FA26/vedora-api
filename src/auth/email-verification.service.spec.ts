import { EmailVerificationCode } from '@prisma/client';
import { createHash } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationService } from './email-verification.service';

describe('EmailVerificationService.send', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const user = { id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2', email: 'a@b.vn' };
  const secondsAgo = (seconds: number) =>
    new Date(now.getTime() - seconds * 1000);
  const pendingCode = (
    overrides: Partial<EmailVerificationCode>,
  ): EmailVerificationCode => ({
    userId: user.id,
    codeHash: 'a'.repeat(64),
    attempts: 0,
    expiresAt: now,
    sentAt: secondsAgo(600),
    firstSentAt: secondsAgo(600),
    resendCount: 0,
    ...overrides,
  });

  const findUnique = jest.fn();
  const upsert = jest.fn();
  const update = jest.fn();
  const deleteMany = jest.fn();
  const sendVerificationCode = jest.fn();
  const service = new EmailVerificationService(
    {
      emailVerificationCode: { findUnique, upsert, update, deleteMany },
    } as unknown as PrismaService,
    { sendVerificationCode } as unknown as MailService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now });
    sendVerificationCode.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  const upserted = () =>
    (upsert.mock.calls[0] as [{ update: Partial<EmailVerificationCode> }])[0]
      .update;

  it('sends the first code and starts a resend window', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 0, firstSentAt: now });
    expect(sendVerificationCode).toHaveBeenCalledWith(
      user.email,
      expect.stringMatching(/^\d{6}$/),
    );
  });

  it('waits 120 seconds between codes', async () => {
    findUnique.mockResolvedValue(pendingCode({ sentAt: secondsAgo(119) }));

    await expect(service.send(user)).resolves.toBe('cooldown');
    expect(sendVerificationCode).not.toHaveBeenCalled();
  });

  it('counts a resend once the cooldown has passed', async () => {
    const firstSentAt = secondsAgo(600);
    findUnique.mockResolvedValue(
      pendingCode({ sentAt: secondsAgo(120), firstSentAt, resendCount: 1 }),
    );

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 2, firstSentAt });
  });

  it('stops after three resends within the hour', async () => {
    findUnique.mockResolvedValue(pendingCode({ resendCount: 3 }));

    await expect(service.send(user)).resolves.toBe('limit');
    expect(sendVerificationCode).not.toHaveBeenCalled();
  });

  it('allows resends again once the hour is over', async () => {
    findUnique.mockResolvedValue(
      pendingCode({ firstSentAt: secondsAgo(3600), resendCount: 3 }),
    );

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 0, firstSentAt: now });
  });

  it('restores the previous code when the email fails', async () => {
    const pending = pendingCode({ resendCount: 1 });
    findUnique.mockResolvedValue(pending);
    sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

    await expect(service.send(user)).rejects.toThrow('Resend is down');
    expect(update).toHaveBeenCalledWith({
      where: { userId: user.id },
      data: pending,
    });
  });

  it('drops a first code whose email failed', async () => {
    findUnique.mockResolvedValue(null);
    sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

    await expect(service.send(user)).rejects.toThrow('Resend is down');
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
  });
});

describe('EmailVerificationService.verify', () => {
  const user = { id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2', email: 'a@b.vn' };
  const hashOf = (code: string) =>
    createHash('sha256').update(`${user.id}:${code}`).digest('hex');

  const codeUpdateMany = jest.fn();
  const findUnique = jest.fn();
  const guessCreateMany = jest.fn();
  const guessUpdateMany = jest.fn();
  const $transaction = jest.fn();
  const service = new EmailVerificationService(
    {
      emailVerificationCode: {
        updateMany: codeUpdateMany,
        findUnique,
        delete: jest.fn(),
      },
      emailVerificationGuesses: {
        createMany: guessCreateMany,
        updateMany: guessUpdateMany,
        deleteMany: jest.fn(),
      },
      user: { update: jest.fn() },
      $transaction,
    } as unknown as PrismaService,
    {} as MailService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    // Window reset, then the guess itself.
    guessUpdateMany.mockResolvedValue({ count: 1 });
    codeUpdateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ codeHash: hashOf('123456') });
  });

  it('verifies a matching code', async () => {
    await expect(service.verify(user, '123456')).resolves.toBe('verified');
    expect($transaction).toHaveBeenCalled();
  });

  it('rejects a wrong code', async () => {
    await expect(service.verify(user, '654321')).resolves.toBe('invalid');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('counts every guess against the email, capped at 15 a day', async () => {
    await service.verify(user, '654321');

    expect(guessUpdateMany).toHaveBeenLastCalledWith({
      where: { email: user.email, guesses: { lt: 15 } },
      data: { guesses: { increment: 1 } },
    });
  });

  it('locks the email once its guesses are used up, even with a fresh code', async () => {
    guessUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.verify(user, '123456')).resolves.toBe('locked');
    expect(codeUpdateMany).not.toHaveBeenCalled();
  });
});
