import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { PublicUser, UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
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

  const create = jest.fn();
  const findByUsername = jest.fn();
  const findPublicById = jest.fn();
  const signAsync = jest.fn().mockResolvedValue('signed-token');
  const issue = jest.fn().mockResolvedValue({
    token: 'refresh-token',
    expiresIn: 2592000,
  });
  const rotate = jest.fn();
  const revoke = jest.fn();
  const usersService = {
    create,
    findByUsername,
    findPublicById,
  } as unknown as UsersService;
  const jwtService = { signAsync } as unknown as JwtService;
  const refreshTokensService = {
    issue,
    rotate,
    revoke,
  } as unknown as RefreshTokensService;
  const configService = {
    get: jest.fn().mockReturnValue(3600),
  } as unknown as ConfigService;
  const service = new AuthService(
    usersService,
    jwtService,
    refreshTokensService,
    configService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('hashes the password and returns a token when registering', async () => {
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
    expect(result).toEqual({
      accessToken: 'signed-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      user: publicUser,
    });
  });

  it('returns a token for valid credentials without exposing the hash', async () => {
    findByUsername.mockResolvedValue({
      ...publicUser,
      passwordHash: await hash('StrongPassword123!', 4),
    });

    const result = await service.login({
      username: 'vedora.user',
      password: 'StrongPassword123!',
    });

    expect(result.user).toEqual(publicUser);
    expect(result.user).not.toHaveProperty('passwordHash');
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
