import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
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
    createdAt: now,
    updatedAt: now,
  };

  const verifiedUser = {
    ...publicUser,
    passwordHash: null as string | null,
    googleId: null as string | null,
    emailVerifiedAt: now as Date | null,
  };

  const create = jest.fn();
  const findByUsername = jest.fn();
  const findByEmail = jest.fn();
  const findByGoogleId = jest.fn();
  const findPublicById = jest.fn();
  const deleteStaleUnverified = jest.fn();
  const linkGoogleAccount = jest.fn();
  const signAsync = jest.fn().mockResolvedValue('signed-token');
  const issue = jest.fn().mockResolvedValue({
    token: 'refresh-token',
    expiresIn: 2592000,
  });
  const rotate = jest.fn();
  const revoke = jest.fn();
  const revokeAllForUser = jest.fn();
  const send = jest.fn();
  const verify = jest.fn();
  const discard = jest.fn();
  const usersService = {
    create,
    findByUsername,
    findByEmail,
    findByGoogleId,
    findPublicById,
    deleteStaleUnverified,
    linkGoogleAccount,
  } as unknown as UsersService;
  const jwtService = { signAsync } as unknown as JwtService;
  const refreshTokensService = {
    issue,
    rotate,
    revoke,
    revokeAllForUser,
  } as unknown as RefreshTokensService;
  const emailVerificationService = {
    send,
    verify,
    discard,
  } as unknown as EmailVerificationService;
  const configService = {
    get: jest.fn().mockReturnValue(3600),
  } as unknown as ConfigService;
  const service = new AuthService(
    usersService,
    jwtService,
    refreshTokensService,
    emailVerificationService,
    configService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue('sent');
  });

  it('hashes the password and emails a code, without tokens, when registering', async () => {
    create.mockResolvedValue(publicUser);

    const result = await service.register({
      username: 'vedora.user',
      password: 'StrongPassword123!',
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'vedora.user',
        fullName: 'Vedora User',
        email: 'hello@vedora.vn',
        passwordHash: expect.stringMatching(/^\$2[aby]\$12\$/) as string,
      }),
    );
    expect(deleteStaleUnverified).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'vedora.user',
        email: 'hello@vedora.vn',
      }),
      expect.any(Date),
    );
    expect(send).toHaveBeenCalledWith(publicUser);
    expect(issue).not.toHaveBeenCalled();
    expect(result).toEqual({ email: 'hello@vedora.vn' });
  });

  it('still registers when the verification email fails', async () => {
    create.mockResolvedValue(publicUser);
    send.mockRejectedValue(new Error('Resend is down'));

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
    findByUsername.mockResolvedValue({
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
    findByUsername.mockResolvedValue(user);

    const login = service.login({
      username: 'vedora.user',
      password: 'StrongPassword123!',
    });

    await expect(login).rejects.toBeInstanceOf(ForbiddenException);
    await expect(login).rejects.toMatchObject({
      response: { code: 'EMAIL_NOT_VERIFIED', email: 'hello@vedora.vn' },
    });
    expect(send).toHaveBeenCalledWith(user);
    expect(issue).not.toHaveBeenCalled();
  });

  it('does not reveal an unverified account to a wrong password', async () => {
    findByUsername.mockResolvedValue({
      ...verifiedUser,
      emailVerifiedAt: null,
      passwordHash: await hash('StrongPassword123!', 4),
    });

    await expect(
      service.login({ username: 'vedora.user', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(send).not.toHaveBeenCalled();
  });

  it('issues tokens once the email code is verified', async () => {
    const user = { ...verifiedUser, emailVerifiedAt: null };
    findByEmail.mockResolvedValue(user);
    verify.mockResolvedValue('verified');

    const result = await service.verifyEmail({
      email: 'hello@vedora.vn',
      code: '123456',
    });

    expect(verify).toHaveBeenCalledWith(user, '123456');
    expect(result.user).toEqual(publicUser);
    expect(result.accessToken).toBe('signed-token');
  });

  it.each([
    ['a wrong code', { ...verifiedUser, emailVerifiedAt: null }, 'invalid'],
    ['an unknown email', null, 'verified'],
    ['an already verified email', verifiedUser, 'verified'],
  ])('rejects verification for %s', async (_, user, result) => {
    findByEmail.mockResolvedValue(user);
    verify.mockResolvedValue(result);

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects verification with 429 once the email is out of guesses', async () => {
    findByEmail.mockResolvedValue({ ...verifiedUser, emailVerifiedAt: null });
    verify.mockResolvedValue('locked');

    await expect(
      service.verifyEmail({ email: 'hello@vedora.vn', code: '123456' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'VERIFY_LIMIT_REACHED' },
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects resends past the limit with 429', async () => {
    findByEmail.mockResolvedValue({ ...verifiedUser, emailVerifiedAt: null });
    send.mockResolvedValue('limit');

    await expect(
      service.resendVerification({ email: 'hello@vedora.vn' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RESEND_LIMIT_REACHED' },
    });
  });

  it('ignores resend requests for unknown or verified emails', async () => {
    findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(verifiedUser);

    await service.resendVerification({ email: 'nobody@vedora.vn' });
    await service.resendVerification({ email: 'hello@vedora.vn' });

    expect(send).not.toHaveBeenCalled();
  });

  it('takes over an unverified account when Google proves the email', async () => {
    const squatted = {
      ...verifiedUser,
      emailVerifiedAt: null,
      passwordHash: 'attacker-hash',
    };
    findByGoogleId.mockResolvedValue(null);
    findByEmail.mockResolvedValue(squatted);
    linkGoogleAccount.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(linkGoogleAccount).toHaveBeenCalledWith(squatted, 'google-sub');
    expect(revokeAllForUser).toHaveBeenCalledWith(publicUser.id);
    expect(discard).toHaveBeenCalledWith(publicUser.id);
  });

  it('keeps existing sessions when linking Google to a verified account', async () => {
    findByGoogleId.mockResolvedValue(null);
    findByEmail.mockResolvedValue(verifiedUser);
    linkGoogleAccount.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(revokeAllForUser).not.toHaveBeenCalled();
  });

  it('creates new Google users as verified', async () => {
    findByGoogleId.mockResolvedValue(null);
    findByEmail.mockResolvedValue(null);
    create.mockResolvedValue(publicUser);

    await service.googleLogin({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerifiedAt: expect.any(Date) as Date }),
    );
  });

  it('rejects invalid credentials with a generic error', async () => {
    findByUsername.mockResolvedValue(null);

    await expect(
      service.login({ username: 'unknown', password: 'WrongPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a new token pair when rotating a refresh token', async () => {
    rotate.mockResolvedValue({
      token: 'rotated-refresh-token',
      expiresIn: 2592000,
      userId: publicUser.id,
    });
    findPublicById.mockResolvedValue(publicUser);

    const result = await service.refresh('current-refresh-token');

    expect(rotate).toHaveBeenCalledWith('current-refresh-token');
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
    revoke.mockResolvedValue(undefined);

    await service.logout('refresh-token');

    expect(revoke).toHaveBeenCalledWith('refresh-token');
  });
});
