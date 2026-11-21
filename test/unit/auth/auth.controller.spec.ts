import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { AuthController } from '../../../src/auth/auth.controller.js';
import type { AuthService } from '../../../src/auth/auth.service.js';
import type { AuthResponseDto } from '../../../src/auth/dto/auth-response.dto.js';
import type { GoogleAuthorizationDto } from '../../../src/auth/dto/google.dto.js';
import type { GoogleOAuthService } from '../../../src/auth/google-oauth.service.js';
import type { TurnstileService } from '../../../src/captcha/turnstile.service.js';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import {
  AccountStatus,
  AccountType,
  UserRole,
} from '../../../src/mongo/models.js';
import type { PublicUser } from '../../../src/users/public-user.js';

describe('AuthController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const publicUser: PublicUser = {
    id: userId,
    username: 'vedora.user',
    fullName: 'Vedora User',
    email: 'hello@vedora.vn',
    avatarUrl: null,
    role: UserRole.USER,
    status: AccountStatus.ACTIVE,
    accountType: AccountType.PERSONAL,
    accountVersion: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const authResponse: AuthResponseDto = {
    accessToken: 'access-jwt',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 2592000,
    user: publicUser,
    actor: null,
  };
  const request = {
    user: {
      sub: userId,
      username: 'vedora.user',
      role: UserRole.USER,
      actorId: null,
    },
  } as AuthenticatedRequest;

  let authService: ReturnType<typeof mockDeep<AuthService>>;
  let googleOAuthService: ReturnType<typeof mockDeep<GoogleOAuthService>>;
  let turnstile: ReturnType<typeof mockDeep<TurnstileService>>;
  let controller: AuthController;

  beforeEach(() => {
    authService = mockDeep<AuthService>();
    googleOAuthService = mockDeep<GoogleOAuthService>();
    turnstile = mockDeep<TurnstileService>();
    controller = new AuthController(authService, googleOAuthService, turnstile);
  });

  it('delegates register() to authService.register', async () => {
    const dto = {
      username: 'vedora.user',
      password: 'StrongPassword123!',
      fullName: 'Vedora User',
      email: 'hello@vedora.vn',
    };
    const expected = { email: 'hello@vedora.vn' };
    authService.register.mockResolvedValue(expected);

    await expect(controller.register(dto)).resolves.toBe(expected);
    expect(authService.register).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('delegates verifyEmail() to authService.verifyEmail', async () => {
    const dto = { email: 'hello@vedora.vn', code: '123456' };
    authService.verifyEmail.mockResolvedValue(authResponse);

    await expect(controller.verifyEmail(dto)).resolves.toBe(authResponse);
    expect(authService.verifyEmail).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('delegates resendVerification() and returns void', async () => {
    const dto = { email: 'hello@vedora.vn' };
    authService.resendVerification.mockResolvedValue(undefined);

    await expect(controller.resendVerification(dto)).resolves.toBeUndefined();
    expect(authService.resendVerification).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('verifies Turnstile before calling authService.login', async () => {
    const dto = {
      username: 'vedora.user',
      password: 'StrongPassword123!',
      turnstileToken: 'cf-token',
    };
    turnstile.verify.mockResolvedValue(true);
    authService.login.mockResolvedValue(authResponse);

    await expect(controller.login(dto)).resolves.toBe(authResponse);
    expect(turnstile.verify).toHaveBeenCalledExactlyOnceWith(
      'cf-token',
      undefined,
    );
    expect(authService.login).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('throws CAPTCHA_FAILED and skips authService.login when Turnstile rejects', async () => {
    const dto = {
      username: 'vedora.user',
      password: 'StrongPassword123!',
      turnstileToken: 'bad-token',
    };
    turnstile.verify.mockResolvedValue(false);

    await expect(controller.login(dto)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AccessDeniedException &&
        error.code === 'CAPTCHA_FAILED'
      );
    });
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('delegates forgotPassword() and returns void', async () => {
    const dto = { email: 'hello@vedora.vn' };
    authService.forgotPassword.mockResolvedValue(undefined);

    await expect(controller.forgotPassword(dto)).resolves.toBeUndefined();
    expect(authService.forgotPassword).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('delegates resetPassword() and returns void', async () => {
    const dto = {
      email: 'hello@vedora.vn',
      code: '123456',
      password: 'NewStrongPassword123!',
    };
    authService.resetPassword.mockResolvedValue(undefined);

    await expect(controller.resetPassword(dto)).resolves.toBeUndefined();
    expect(authService.resetPassword).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('delegates refresh() with the refreshToken string', async () => {
    authService.refresh.mockResolvedValue(authResponse);

    await expect(
      controller.refresh({ refreshToken: 'raw-refresh-token' }),
    ).resolves.toBe(authResponse);
    expect(authService.refresh).toHaveBeenCalledExactlyOnceWith(
      'raw-refresh-token',
    );
  });

  it('delegates logout() with the refreshToken string and returns void', async () => {
    authService.logout.mockResolvedValue(undefined);

    await expect(
      controller.logout({ refreshToken: 'raw-refresh-token' }),
    ).resolves.toBeUndefined();
    expect(authService.logout).toHaveBeenCalledExactlyOnceWith(
      'raw-refresh-token',
    );
  });

  it('delegates googleAuthorize() to googleOAuthService.authorize', async () => {
    const payload: GoogleAuthorizationDto = {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      state: 'state-123',
      codeVerifier: 'verifier-123',
    };
    googleOAuthService.authorize.mockResolvedValue(payload);

    await expect(controller.googleAuthorize()).resolves.toBe(payload);
    expect(googleOAuthService.authorize).toHaveBeenCalledOnce();
  });

  it('exchanges Google code and logs in the returned profile', async () => {
    const profile = {
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    };
    googleOAuthService.exchangeCode.mockResolvedValue(profile);
    authService.googleLogin.mockResolvedValue(authResponse);

    await expect(
      controller.google({ code: 'auth-code', codeVerifier: 'pkce-verifier' }),
    ).resolves.toBe(authResponse);
    expect(googleOAuthService.exchangeCode).toHaveBeenCalledExactlyOnceWith(
      'auth-code',
      'pkce-verifier',
    );
    expect(authService.googleLogin).toHaveBeenCalledExactlyOnceWith(profile);
  });

  it('does not call authService.googleLogin when code exchange fails', async () => {
    googleOAuthService.exchangeCode.mockRejectedValue(new Error('bad code'));

    await expect(
      controller.google({ code: 'bad', codeVerifier: 'pkce-verifier' }),
    ).rejects.toThrow('bad code');
    expect(authService.googleLogin).not.toHaveBeenCalled();
  });

  it('delegates me() to authService.me with request.user', async () => {
    const current = { ...publicUser, actor: null };
    authService.me.mockResolvedValue(current);

    await expect(controller.me(request)).resolves.toBe(current);
    expect(authService.me).toHaveBeenCalledExactlyOnceWith(request.user);
  });
});
