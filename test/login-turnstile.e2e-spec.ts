import { INestApplication } from '@nestjs/common';
import { AccessDeniedException } from '../src/common/exceptions/access-denied.exception.js';
import { UnauthenticatedException } from '../src/common/exceptions/unauthenticated.exception.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AuthService } from '../src/auth/auth.service.js';
import { TurnstileService } from '../src/nutrition-chat/guest/turnstile.service.js';
import { AccountStatus, UserRole } from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';

describe('Password login requires Turnstile (HTTP)', () => {
  const auth = mockDeep<AuthService>();
  const turnstile = mockDeep<TurnstileService>();
  const credentials = {
    username: 'vedora.user',
    password: 'StrongPassword123!',
  };
  const body = { ...credentials, turnstileToken: 'fresh-turnstile-token' };
  let e2e: E2eApp;
  let app: INestApplication<App>;

  beforeAll(async () => {
    e2e = await createE2eApp('turnstile_e2e', (builder) =>
      builder
        .overrideProvider(AuthService)
        .useValue(auth)
        .overrideProvider(TurnstileService)
        .useValue(turnstile),
    );
    app = e2e.app;
  });

  beforeEach(() => {
    mockReset(auth);
    mockReset(turnstile);
    turnstile.verify.mockResolvedValue(true);
    auth.login.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 2592000,
      user: {
        id: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
        username: credentials.username,
        fullName: 'Vedora User',
        email: 'user@example.test',
        role: UserRole.USER,
        status: AccountStatus.ACTIVE,
        accountVersion: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  });
  afterAll(async () => e2e?.close());

  it.each([undefined, null, '', '   ', 123, 'x'.repeat(2049)])(
    'rejects a missing/malformed token before verification or login: %j',
    async (token) => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ ...credentials, turnstileToken: token })
        .expect(400);
      expect(turnstile.verify).not.toHaveBeenCalled();
      expect(auth.login).not.toHaveBeenCalled();
    },
  );

  it('rejects failed/expired verification before credentials are processed', async () => {
    turnstile.verify.mockResolvedValue(false);
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(403);
    expect(response.body).toMatchObject({ code: 'CAPTCHA_FAILED' });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('verifies the token before issuing a normal auth response', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(200);
    expect(response.body).toMatchObject({
      accessToken: 'access-token',
      tokenType: 'Bearer',
    });
    expect(turnstile.verify).toHaveBeenCalledWith(
      body.turnstileToken,
      undefined,
    );
    expect(auth.login).toHaveBeenCalledWith(body);
  });

  it('does not trust a success flag sent by the client', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ ...body, captchaVerified: true })
      .expect(400);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('rejects a reused token when Siteverify rejects the second attempt', async () => {
    turnstile.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(403);
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('preserves the invalid credentials response after a successful challenge', async () => {
    auth.login.mockRejectedValue(
      new UnauthenticatedException(
        'UNAUTHORIZED',
        'Invalid username or password',
      ),
    );
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(401);
    expect(turnstile.verify).toHaveBeenCalledTimes(1);
  });

  it('preserves the email verification flow after a successful challenge', async () => {
    auth.login.mockRejectedValue(
      new AccessDeniedException(
        'EMAIL_NOT_VERIFIED',
        'Email address is not verified',
        { email: 'user@example.test' },
      ),
    );
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      details: { email: 'user@example.test' },
    });
  });
});
