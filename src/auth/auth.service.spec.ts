import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { User, UserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PublicUser, UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { RefreshTokensService } from './refresh-tokens.service';

describe('AuthService', () => {
  const now = new Date('2026-09-22T00:00:00.000Z');
  const publicUser: PublicUser = {
    id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
    username: 'vedora.user',
    fullName: 'Vedora User',
    email: 'hello@vedora.vn',
    role: UserRole.USER,
    createdAt: now,
    updatedAt: now,
  };

  const verifiedUser: User = {
    ...publicUser,
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    passwordHash: null,
    googleId: null,
    emailVerifiedAt: now,
  };

  let service: AuthService;
  let users: DeepMockProxy<UsersService>;
  let refreshTokens: DeepMockProxy<RefreshTokensService>;
  let emailVerification: DeepMockProxy<EmailVerificationService>;

  beforeEach(async () => {
    users = mockDeep<UsersService>();
    refreshTokens = mockDeep<RefreshTokensService>();
    emailVerification = mockDeep<EmailVerificationService>();
    const jwt = mockDeep<JwtService>();
    jwt.signAsync.mockResolvedValue('signed-token');
    refreshTokens.issue.mockResolvedValue({
      token: 'refresh-token',
      expiresIn: 2592000,
    });
    emailVerification.send.mockResolvedValue('sent');

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
        { provide: RefreshTokensService, useValue: refreshTokens },
        { provide: EmailVerificationService, useValue: emailVerification },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_ACCESS_TTL: 3600 }),
        },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('hashes the password and emails a code, without tokens, when registering', async () => {
    users.create.mockResolvedValue(publicUser);

    const result = await service.register({
      username: 'vedora.user',
      password: 'StrongPassword123!',
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
    });

    const [created] = users.create.mock.calls[0];
    expect(created).toMatchObject({
      username: 'vedora.user',
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
    });
    expect(created.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(users.deleteStaleUnverified).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'vedora.user',
        email: 'hello@vedora.vn',
      }),
      expect.any(Date),
    );
    expect(emailVerification.send).toHaveBeenCalledWith(publicUser);
    expect(refreshTokens.issue).not.toHaveBeenCalled();
    expect(result).toEqual({ email: 'hello@vedora.vn' });
  });

  it('still registers when the verification email fails', async () => {
    users.create.mockResolvedValue(publicUser);
    emailVerification.send.mockRejectedValue(new Error('Resend is down'));

    await expect(
      service.register({
        username: 'vedora.user',
        password: 'StrongPassword123!',
        fullName: 'Vedora User',
        email: 'hello@vedora.vn',
      }),
    ).resolves.toEqual({ email: 'hello@vedora.vn' });
  });

  it('returns a token for valid credentials without exposing the hash', async () => {
    users.findByUsername.mockResolvedValue({
      ...verifiedUser,
      passwordHash: await hash('StrongPassword123!', 4),
    });

    const result = await service.login({
      username: 'vedora.user',
      password: 'StrongPassword123!',
    });

    expect(result.user).toEqual(publicUser);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('sends a code instead of tokens when the email is unverified', async () => {
    const user = {
      ...verifiedUser,
      emailVerifiedAt: null,
      passwordHash: await hash('StrongPassword123!', 4),
    };
    users.findByUsername.mockResolvedValue(user);

    const login = service.login({
      username: 'vedora.user',
      password: 'StrongPassword123!',
    });

    await expect(login).rejects.toBeInstanceOf(ForbiddenException);
    await expect(login).rejects.toMatchObject({
      response: { code: 'EMAIL_NOT_VERIFIED', email: 'hello@vedora.vn' },
    });
    expect(emailVerification.send).toHaveBeenCalledWith(user);
    expect(refreshTokens.issue).not.toHaveBeenCalled();
  });

  it('does not reveal an unverified account to a wrong password', async () => {
    users.findByUsername.mockResolvedValue({
      ...verifiedUser,
      emailVerifiedAt: null,
      passwordHash: await hash('StrongPassword123!', 4),
    });

    await expect(
      service.login({ username: 'vedora.user', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(emailVerification.send).not.toHaveBeenCalled();
  });

  it('issues tokens once the email code is verified', async () => {
    const user = { ...verifiedUser, emailVerifiedAt: null };
    users.findByEmail.mockResolvedValue(user);
    emailVerification.verify.mockResolvedValue('verified');

    const result = await service.verifyEmail({
      email: 'hello@vedora.vn',
      code: '123456',
    });

    expect(emailVerification.verify).toHaveBeenCalledWith(user, '123456');
    expect(result.user).toEqual(publicUser);
    expect(result.accessToken).toBe('signed-token');
  });

  it.each([
    ['a wrong code', { ...verifiedUser, emailVerifiedAt: null }, 'invalid'],
    ['an unknown email', null, 'verified'],
    ['an already verified email', verifiedUser, 'verified'],
  ] as const)('rejects verification for %s', async (_, user, result) => {
    users.findByEmail.mockResolvedValue(user);
    emailVerification.verify.mockResolvedValue(result);

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(refreshTokens.issue).not.toHaveBeenCalled();
  });

  it('rejects verification with 429 once the email is out of guesses', async () => {
    users.findByEmail.mockResolvedValue({
      ...verifiedUser,
      emailVerifiedAt: null,
    });
    emailVerification.verify.mockResolvedValue('locked');

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'VERIFY_LIMIT_REACHED' },
    });
    expect(refreshTokens.issue).not.toHaveBeenCalled();
  });

  it('rejects resends past the limit with 429', async () => {
    users.findByEmail.mockResolvedValue({
      ...verifiedUser,
      emailVerifiedAt: null,
    });
    emailVerification.send.mockResolvedValue('limit');

    await expect(
      service.resendVerification({ email: 'hello@vedora.vn' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RESEND_LIMIT_REACHED' },
    });
  });

  it('ignores resend requests for unknown or verified emails', async () => {
    users.findByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(verifiedUser);

    await service.resendVerification({ email: 'nobody@vedora.vn' });
    await service.resendVerification({ email: 'hello@vedora.vn' });

    expect(emailVerification.send).not.toHaveBeenCalled();
  });

  it('takes over an unverified account when Google proves the email', async () => {
    const squatted = {
      ...verifiedUser,
      emailVerifiedAt: null,
      passwordHash: 'attacker-hash',
    };
    users.findByGoogleId.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(squatted);
    users.linkGoogleAccount.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(users.linkGoogleAccount).toHaveBeenCalledWith(
      squatted,
      'google-sub',
    );
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith(publicUser.id);
    expect(emailVerification.discard).toHaveBeenCalledWith(publicUser.id);
  });

  it('keeps existing sessions when linking Google to a verified account', async () => {
    users.findByGoogleId.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(verifiedUser);
    users.linkGoogleAccount.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('creates new Google users as verified', async () => {
    users.findByGoogleId.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(null);
    users.create.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    const [created] = users.create.mock.calls[0];
    expect(created.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects invalid credentials with a generic error', async () => {
    users.findByUsername.mockResolvedValue(null);

    await expect(
      service.login({ username: 'unknown', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a new token pair when rotating a refresh token', async () => {
    refreshTokens.rotate.mockResolvedValue({
      token: 'rotated-refresh-token',
      expiresIn: 2592000,
      userId: publicUser.id,
    });
    users.findPublicById.mockResolvedValue(publicUser);

    const result = await service.refresh('current-refresh-token');

    expect(refreshTokens.rotate).toHaveBeenCalledWith('current-refresh-token');
    expect(result).toEqual({
      accessToken: 'signed-token',
      refreshToken: 'rotated-refresh-token',
      tokenType: 'Bearer',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      user: publicUser,
    });
  });

  it('revokes a refresh-token family on logout', async () => {
    refreshTokens.revoke.mockResolvedValue(undefined);

    await service.logout('refresh-token');

    expect(refreshTokens.revoke).toHaveBeenCalledWith('refresh-token');
  });
});
