import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PasswordResetCode } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordResetService } from './password-reset.service';

const user = {
  id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  email: 'a@b.vn',
  emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
};

async function createService() {
  const prisma = mockDeep<PrismaService>();
  const mail = mockDeep<MailService>();
  const moduleRef = await Test.createTestingModule({
    providers: [
      PasswordResetService,
      { provide: PrismaService, useValue: prisma },
      { provide: MailService, useValue: mail },
    ],
  }).compile();
  return { service: moduleRef.get(PasswordResetService), prisma, mail };
}

describe('PasswordResetService.send', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const secondsAgo = (seconds: number) =>
    new Date(now.getTime() - seconds * 1000);
  const pendingCode = (
    overrides: Partial<PasswordResetCode>,
  ): PasswordResetCode => ({
    userId: user.id,
    codeHash: 'a'.repeat(64),
    attempts: 0,
    expiresAt: now,
    sentAt: secondsAgo(600),
    firstSentAt: secondsAgo(600),
    resendCount: 0,
    ...overrides,
  });

  let service: PasswordResetService;
  let prisma: DeepMockProxy<PrismaService>;
  let mail: DeepMockProxy<MailService>;

  beforeEach(async () => {
    vi.useFakeTimers({ now });
    ({ service, prisma, mail } = await createService());
    mail.sendPasswordResetCode.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  const upserted = () =>
    prisma.passwordResetCode.upsert.mock.calls[0][0].update;

  it('emails a six-digit code and stores only its hash', async () => {
    prisma.passwordResetCode.findUnique.mockResolvedValue(null);

    await expect(service.send(user)).resolves.toBe('sent');
    const [to, code] = mail.sendPasswordResetCode.mock.calls[0];
    expect(to).toBe(user.email);
    expect(code).toMatch(/^\d{6}$/);
    expect(upserted()).toMatchObject({ resendCount: 0, firstSentAt: now });
    expect(upserted().codeHash).not.toContain(code);
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('waits 120 seconds between codes', async () => {
    prisma.passwordResetCode.findUnique.mockResolvedValue(
      pendingCode({ sentAt: secondsAgo(119) }),
    );

    await expect(service.send(user)).resolves.toBe('cooldown');
    expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('stops after three resends within the hour', async () => {
    prisma.passwordResetCode.findUnique.mockResolvedValue(
      pendingCode({ resendCount: 3 }),
    );

    await expect(service.send(user)).resolves.toBe('limit');
    expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('restores the previous code when the email fails', async () => {
    const pending = pendingCode({ resendCount: 1 });
    prisma.passwordResetCode.findUnique.mockResolvedValue(pending);
    mail.sendPasswordResetCode.mockRejectedValue(new Error('Resend is down'));

    await expect(service.send(user)).rejects.toThrow('Resend is down');
    expect(prisma.passwordResetCode.update).toHaveBeenCalledWith({
      where: { userId: user.id },
      data: pending,
    });
  });
});

describe('PasswordResetService.reset', () => {
  const hashOf = (code: string) =>
    createHash('sha256')
      .update(`password-reset:${user.id}:${code}`)
      .digest('hex');

  let service: PasswordResetService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    ({ service, prisma } = await createService());
    prisma.emailVerificationGuesses.updateMany.mockResolvedValue({ count: 1 });
    prisma.passwordResetCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.passwordResetCode.findUnique.mockResolvedValue({
      userId: user.id,
      codeHash: hashOf('123456'),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      sentAt: new Date(),
      firstSentAt: new Date(),
      resendCount: 0,
    });
    prisma.passwordResetCode.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
  });

  it('replaces the password with a matching code and uses the code up', async () => {
    await expect(service.reset(user, '123456', 'new-hash')).resolves.toBe(
      'reset',
    );
    expect(prisma.passwordResetCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: user.id, codeHash: hashOf('123456') },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { passwordHash: 'new-hash', emailVerifiedAt: user.emailVerifiedAt },
    });
  });

  it('verifies an unverified email on the way', async () => {
    await service.reset({ ...user, emailVerifiedAt: null }, '123456', 'h');

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.emailVerificationCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: user.id },
    });
  });

  it('rejects a wrong code without changing the password', async () => {
    await expect(service.reset(user, '654321', 'h')).resolves.toBe('invalid');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not accept the matching email verification code', async () => {
    prisma.passwordResetCode.findUnique.mockResolvedValue({
      userId: user.id,
      // How EmailVerificationService hashes the same digits.
      codeHash: createHash('sha256').update(`${user.id}:123456`).digest('hex'),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      sentAt: new Date(),
      firstSentAt: new Date(),
      resendCount: 0,
    });

    await expect(service.reset(user, '123456', 'h')).resolves.toBe('invalid');
  });

  it('rejects expired or exhausted codes before comparing', async () => {
    prisma.passwordResetCode.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.reset(user, '123456', 'h')).resolves.toBe('invalid');
    expect(prisma.passwordResetCode.findUnique).not.toHaveBeenCalled();
  });

  it('lets only one of two parallel resets with the right code win', async () => {
    prisma.passwordResetCode.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.reset(user, '123456', 'h')).resolves.toBe('invalid');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('shares the per-email guess budget with verification codes', async () => {
    prisma.emailVerificationGuesses.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.reset(user, '123456', 'h')).resolves.toBe('locked');
    expect(prisma.passwordResetCode.updateMany).not.toHaveBeenCalled();
  });
});
