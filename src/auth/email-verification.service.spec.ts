import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EmailVerificationCode } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationService } from './email-verification.service';

async function createService() {
  const prisma = mockDeep<PrismaService>();
  const mail = mockDeep<MailService>();
  const moduleRef = await Test.createTestingModule({
    providers: [
      EmailVerificationService,
      { provide: PrismaService, useValue: prisma },
      { provide: MailService, useValue: mail },
    ],
  }).compile();
  return { service: moduleRef.get(EmailVerificationService), prisma, mail };
}

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

  let service: EmailVerificationService;
  let prisma: DeepMockProxy<PrismaService>;
  let mail: DeepMockProxy<MailService>;

  beforeEach(async () => {
    vi.useFakeTimers({ now });
    ({ service, prisma, mail } = await createService());
    mail.sendVerificationCode.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  const upserted = () => prisma.emailVerificationCode.upsert.mock.calls[0][0].update;

  it('sends the first code and starts a resend window', async () => {
    prisma.emailVerificationCode.findUnique.mockResolvedValue(null);

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 0, firstSentAt: now });
    expect(mail.sendVerificationCode).toHaveBeenCalledWith(
      user.email,
      expect.stringMatching(/^\d{6}$/),
    );
  });

  it('waits 120 seconds between codes', async () => {
    prisma.emailVerificationCode.findUnique.mockResolvedValue(pendingCode({ sentAt: secondsAgo(119) }));

    await expect(service.send(user)).resolves.toBe('cooldown');
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('counts a resend once the cooldown has passed', async () => {
    const firstSentAt = secondsAgo(600);
    prisma.emailVerificationCode.findUnique.mockResolvedValue(
      pendingCode({ sentAt: secondsAgo(120), firstSentAt, resendCount: 1 }),
    );

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 2, firstSentAt });
  });

  it('stops after three resends within the hour', async () => {
    prisma.emailVerificationCode.findUnique.mockResolvedValue(pendingCode({ resendCount: 3 }));

    await expect(service.send(user)).resolves.toBe('limit');
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('allows resends again once the hour is over', async () => {
    prisma.emailVerificationCode.findUnique.mockResolvedValue(
      pendingCode({ firstSentAt: secondsAgo(3600), resendCount: 3 }),
    );

    await expect(service.send(user)).resolves.toBe('sent');
    expect(upserted()).toMatchObject({ resendCount: 0, firstSentAt: now });
  });

  it('restores the previous code when the email fails', async () => {
    const pending = pendingCode({ resendCount: 1 });
    prisma.emailVerificationCode.findUnique.mockResolvedValue(pending);
    mail.sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

    await expect(service.send(user)).rejects.toThrow('Resend is down');
    expect(prisma.emailVerificationCode.update).toHaveBeenCalledWith({
      where: { userId: user.id },
      data: pending,
    });
  });

  it('drops a first code whose email failed', async () => {
    prisma.emailVerificationCode.findUnique.mockResolvedValue(null);
    mail.sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

    await expect(service.send(user)).rejects.toThrow('Resend is down');
    expect(prisma.emailVerificationCode.deleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
  });
});

describe('EmailVerificationService.verify', () => {
  const user = { id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2', email: 'a@b.vn' };
  const hashOf = (code: string) =>
    createHash('sha256').update(`${user.id}:${code}`).digest('hex');

  let service: EmailVerificationService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    ({ service, prisma } = await createService());
    // Window reset, then the guess itself.
    prisma.emailVerificationGuesses.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailVerificationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailVerificationCode.findUnique.mockResolvedValue({
      userId: user.id,
      codeHash: hashOf('123456'),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      sentAt: new Date(),
      firstSentAt: new Date(),
      resendCount: 0,
    });
  });

  it('verifies a matching code', async () => {
    await expect(service.verify(user, '123456')).resolves.toBe('verified');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rejects a wrong code', async () => {
    await expect(service.verify(user, '654321')).resolves.toBe('invalid');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('counts every guess against the email, capped at 15 a day', async () => {
    await service.verify(user, '654321');

    expect(prisma.emailVerificationGuesses.updateMany).toHaveBeenLastCalledWith({
      where: { email: user.email, guesses: { lt: 15 } },
      data: { guesses: { increment: 1 } },
    });
  });

  it('locks the email once its guesses are used up, even with a fresh code', async () => {
    prisma.emailVerificationGuesses.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.verify(user, '123456')).resolves.toBe('locked');
    expect(prisma.emailVerificationCode.updateMany).not.toHaveBeenCalled();
  });
});
