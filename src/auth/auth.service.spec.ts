import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { compare } from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { createUser } from '../../test/fixtures.js';
import { MailService } from '../mail/mail.service.js';
import {
  EmailVerificationGuesses,
  OneTimeCode,
  OneTimeCodePurpose,
  RefreshToken,
  User,
} from '../mongo/models.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { hashCode } from './one-time-code.js';
import { hashPassword } from './password.js';
import { AuthService } from './auth.service.js';
import { AccountsService } from '../users/accounts.service.js';

const PASSWORD = 'StrongPassword123!';
const verificationHash = (userId: string, code: string) =>
  hashCode(userId, code);
const resetHash = (userId: string, code: string) =>
  hashCode(`password-reset:${userId}`, code);

describe('AuthService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AuthService;
  let refreshTokens: RefreshTokensService;
  const mail = {
    sendVerificationCode: vi.fn(),
    sendPasswordResetCode: vi.fn(),
  };
  let passwordHash: string;

  const codes = () => db.connection.model<OneTimeCode>(OneTimeCode.name);
  const tokens = () => db.connection.model<RefreshToken>(RefreshToken.name);
  const userDocs = () => db.connection.model<User>(User.name);
  const guesses = () =>
    db.connection.model<EmailVerificationGuesses>(
      EmailVerificationGuesses.name,
    );

  const seedCode = (
    userId: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    code: string,
    fields: Record<string, unknown> = {},
  ) =>
    codes().create({
      _id: `${userId}:${purpose}`,
      userId,
      purpose: purpose as OneTimeCodePurpose,
      codeHash:
        purpose === 'PASSWORD_RESET'
          ? resetHash(userId, code)
          : verificationHash(userId, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      sentAt: new Date(),
      firstSentAt: new Date(),
      resendCount: 0,
      ...fields,
    });

  const makeUser = (fields: Record<string, unknown> = {}) =>
    createUser(db, {
      username: 'vedora.user',
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
      passwordHash,
      ...fields,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('authservice'))],
      providers: [
        AccountsService,
        RefreshTokensService,
        EmailVerificationService,
        PasswordResetService,
        AuthService,
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_ACCESS_TTL: 3600,
            REFRESH_TOKEN_TTL: 2592000,
          }),
        },
        {
          provide: JwtService,
          useValue: new JwtService({
            secret: 'auth-service-spec-secret-longer-than-32-chars',
            signOptions: { expiresIn: 3600 },
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AuthService);
    refreshTokens = app.get(RefreshTokensService);
    passwordHash = await hashPassword(PASSWORD);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mail.sendVerificationCode.mockResolvedValue(undefined);
    mail.sendPasswordResetCode.mockResolvedValue(undefined);
    await userDocs().deleteMany({});
    await codes().deleteMany({});
    await tokens().deleteMany({});
    await guesses().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('hashes the password and emails a code, without tokens, when registering', async () => {
    const result = await service.register({
      username: 'vedora.user',
      password: PASSWORD,
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
    });

    expect(result).toEqual({ email: 'hello@vedora.vn' });
    const stored = await userDocs().findOne({ email: 'hello@vedora.vn' });
    expect(stored).toMatchObject({
      username: 'vedora.user',
      fullName: 'Vedora User',
      status: 'PENDING_EMAIL',
      role: 'USER',
    });
    await expect(
      compare(PASSWORD, stored?.passwordHash as string),
    ).resolves.toBe(true);
    expect(mail.sendVerificationCode).toHaveBeenCalledWith(
      'hello@vedora.vn',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(await tokens().countDocuments()).toBe(0);
    expect(await codes().countDocuments()).toBe(1);
  });

  it('still registers when the verification email fails', async () => {
    mail.sendVerificationCode.mockRejectedValue(new Error('Resend is down'));

    await expect(
      service.register({
        username: 'vedora.user',
        password: PASSWORD,
        fullName: 'Vedora User',
        email: 'hello@vedora.vn',
      }),
    ).resolves.toEqual({ email: 'hello@vedora.vn' });
    expect(await userDocs().countDocuments()).toBe(1);
  });

  it('returns a token for valid credentials without exposing the hash', async () => {
    const user = await makeUser();

    const result = await service.login({
      username: 'vedora.user',
      password: PASSWORD,
    });

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      user: { id: user.id, username: 'vedora.user', role: 'USER' },
    });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(await tokens().countDocuments()).toBe(1);
  });

  it('sends a code instead of tokens when the email is unverified', async () => {
    const user = await makeUser({ emailVerifiedAt: null });

    await expect(
      service.login({ username: 'vedora.user', password: PASSWORD }),
    ).rejects.toMatchObject({
      response: { code: 'EMAIL_NOT_VERIFIED', email: 'hello@vedora.vn' },
    });
    expect(mail.sendVerificationCode).toHaveBeenCalledWith(
      'hello@vedora.vn',
      expect.any(String),
    );
    expect(await tokens().countDocuments()).toBe(0);
    expect(await codes().countDocuments()).toBe(1);
    expect(user.status).toBe('ACTIVE');
  });

  it('does not reveal an unverified account to a wrong password', async () => {
    await makeUser({ emailVerifiedAt: null });

    await expect(
      service.login({ username: 'vedora.user', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('issues tokens once the email code is verified', async () => {
    const user = await makeUser({ emailVerifiedAt: null });
    await seedCode(user.id, 'EMAIL_VERIFICATION', '123456');

    const result = await service.verifyEmail({
      email: 'hello@vedora.vn',
      code: '123456',
    });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.user).toMatchObject({ id: user.id, status: 'ACTIVE' });
    expect(await userDocs().findOne({ _id: user.id })).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await codes().countDocuments()).toBe(0);
  });

  it.each([
    ['a wrong code', '654321'],
    ['an unknown email', null],
  ] as const)('rejects verification for %s', async (_, code) => {
    if (code) {
      const user = await makeUser({ emailVerifiedAt: null });
      await seedCode(user.id, 'EMAIL_VERIFICATION', '123456');
    }
    await expect(
      service.verifyEmail(
        code
          ? { email: 'hello@vedora.vn', code }
          : { email: 'nobody@vedora.vn', code: '123456' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await tokens().countDocuments()).toBe(0);
  });

  it('rejects verification for an already verified email', async () => {
    await makeUser();

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await tokens().countDocuments()).toBe(0);
  });

  it('rejects verification with 429 once the email is out of guesses', async () => {
    const user = await makeUser({ emailVerifiedAt: null });
    await seedCode(user.id, 'EMAIL_VERIFICATION', '123456');
    await guesses().create({
      _id: 'hello@vedora.vn',
      guesses: 15,
      windowStart: new Date(),
    });

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'VERIFY_LIMIT_REACHED' },
    });
    expect(await tokens().countDocuments()).toBe(0);
  });

  it('rejects resends past the limit with 429', async () => {
    const user = await makeUser({ emailVerifiedAt: null });
    await seedCode(user.id, 'EMAIL_VERIFICATION', '123456', {
      sentAt: new Date(Date.now() - 200_000),
      firstSentAt: new Date(Date.now() - 600_000),
      resendCount: 3,
    });

    await expect(
      service.resendVerification({ email: 'hello@vedora.vn' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RESEND_LIMIT_REACHED' },
    });
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('ignores resend requests for unknown or verified emails', async () => {
    await makeUser();

    await service.resendVerification({ email: 'nobody@vedora.vn' });
    await service.resendVerification({ email: 'hello@vedora.vn' });

    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('emails a reset code to a registered email', async () => {
    await makeUser();

    await service.forgotPassword({ email: 'hello@vedora.vn' });

    expect(mail.sendPasswordResetCode).toHaveBeenCalledWith(
      'hello@vedora.vn',
      expect.stringMatching(/^\d{6}$/),
    );
  });

  it('answers forgot-password for unknown emails without sending anything', async () => {
    await expect(
      service.forgotPassword({ email: 'nobody@vedora.vn' }),
    ).resolves.toBeUndefined();
    expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('rejects reset codes past the resend limit with 429', async () => {
    const user = await makeUser();
    await seedCode(user.id, 'PASSWORD_RESET', '123456', {
      sentAt: new Date(Date.now() - 200_000),
      firstSentAt: new Date(Date.now() - 600_000),
      resendCount: 3,
    });

    await expect(
      service.forgotPassword({ email: 'hello@vedora.vn' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RESEND_LIMIT_REACHED' },
    });
  });

  it('reports 503 when the reset email cannot be sent', async () => {
    await makeUser();
    mail.sendPasswordResetCode.mockRejectedValue(new Error('Resend is down'));

    await expect(
      service.forgotPassword({ email: 'hello@vedora.vn' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('sets the new password and signs out every session after a reset', async () => {
    const user = await makeUser();
    await refreshTokens.issue(user.id);
    await seedCode(user.id, 'PASSWORD_RESET', '123456');

    await service.resetPassword({
      email: 'hello@vedora.vn',
      code: '123456',
      password: 'NewStrongPassword123!',
    });

    const stored = await userDocs().findOne({ _id: user.id });
    await expect(
      compare('NewStrongPassword123!', stored?.passwordHash as string),
    ).resolves.toBe(true);
    for (const token of await tokens().find().exec()) {
      expect(token.revokedAt).toBeInstanceOf(Date);
    }
  });

  it('rejects a wrong reset code without touching sessions', async () => {
    const user = await makeUser();
    await refreshTokens.issue(user.id);
    await seedCode(user.id, 'PASSWORD_RESET', '123456');

    await expect(
      service.resetPassword({
        email: 'hello@vedora.vn',
        code: '000000',
        password: 'NewStrongPassword123!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const token of await tokens().find().exec()) {
      expect(token.revokedAt).toBeNull();
    }
  });

  it('rejects a reset for an unknown email like a wrong code', async () => {
    await expect(
      service.resetPassword({
        email: 'nobody@vedora.vn',
        code: '123456',
        password: 'NewStrongPassword123!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects resets with 429 once the email is out of guesses', async () => {
    const user = await makeUser();
    await refreshTokens.issue(user.id);
    await seedCode(user.id, 'PASSWORD_RESET', '123456');
    await guesses().create({
      _id: 'hello@vedora.vn',
      guesses: 15,
      windowStart: new Date(),
    });

    await expect(
      service.resetPassword({
        email: 'hello@vedora.vn',
        code: '123456',
        password: 'NewStrongPassword123!',
      }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'VERIFY_LIMIT_REACHED' },
    });
    for (const token of await tokens().find().exec()) {
      expect(token.revokedAt).toBeNull();
    }
  });

  it('takes over an unverified account when Google proves the email', async () => {
    const user = await makeUser({
      emailVerifiedAt: null,
      passwordHash: 'attacker-hash',
    });
    await refreshTokens.issue(user.id);
    await seedCode(user.id, 'EMAIL_VERIFICATION', '123456');

    const result = await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(result.user).toMatchObject({ id: user.id, status: 'ACTIVE' });
    expect(await userDocs().findOne({ _id: user.id })).toMatchObject({
      googleId: 'google-sub',
      passwordHash: null,
      status: 'ACTIVE',
    });
    expect(
      (await userDocs().findOne({ _id: user.id }))?.emailVerifiedAt,
    ).toBeInstanceOf(Date);
    const stored = await tokens().find().exec();
    expect(stored.filter((token) => token.revokedAt !== null)).toHaveLength(1);
    expect(await codes().countDocuments()).toBe(0);
  });

  it('keeps existing sessions when linking Google to a verified account', async () => {
    const user = await makeUser();

    const result = await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(result.user.id).toBe(user.id);
    expect(await userDocs().findOne({ _id: user.id })).toMatchObject({
      googleId: 'google-sub',
    });
  });

  it('creates new Google users as verified', async () => {
    const result = await service.googleLogin({
      googleId: 'google-sub',
      email: 'new@vedora.vn',
      fullName: 'New Person',
    });

    const stored = await userDocs().findOne({ _id: result.user.id });
    expect(stored).toMatchObject({
      googleId: 'google-sub',
      status: 'ACTIVE',
      passwordHash: null,
    });
    expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects suspended accounts without issuing tokens', async () => {
    await makeUser({ status: 'SUSPENDED' });

    await expect(
      service.login({ username: 'vedora.user', password: PASSWORD }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
    expect(await tokens().countDocuments()).toBe(0);
  });

  it('rejects invalid credentials with a generic error', async () => {
    await expect(
      service.login({ username: 'unknown', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a new token pair when rotating a refresh token', async () => {
    const user = await makeUser();
    const issued = await refreshTokens.issue(user.id);
    const before = await tokens().countDocuments();

    const result = await service.refresh(issued.token);

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      user: { id: user.id },
    });
    expect(result.refreshToken).not.toBe(issued.token);
    expect(await tokens().countDocuments()).toBe(before + 1);
  });

  it('revokes a refresh-token family on logout', async () => {
    const user = await makeUser();
    const issued = await refreshTokens.issue(user.id);

    await service.logout(issued.token);

    await expect(refreshTokens.rotate(issued.token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a login for a deleted account', async () => {
    const user = await makeUser();
    await userDocs().updateOne(
      { _id: user.id },
      { $set: { status: 'DELETED' } },
    );

    await expect(
      service.login({ username: 'vedora.user', password: PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
