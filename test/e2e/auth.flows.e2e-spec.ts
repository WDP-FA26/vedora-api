import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { z } from 'zod';
import { hashPassword } from '../../src/auth-core/password.js';
import { GoogleOAuthService } from '../../src/auth/google-oauth.service.js';
import type { GoogleProfileUser } from '../../src/auth/google-auth.types.js';
import { UnauthenticatedException } from '../../src/common/exceptions/unauthenticated.exception.js';
import { TurnstileService } from '../../src/captcha/turnstile.service.js';
import { MailService } from '../../src/mail/mail.service.js';
import {
  AccountStatus,
  OneTimeCode,
  RefreshToken,
  User,
  UserRole,
} from '../../src/mongo/models.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

/**
 * Black-box flows for /auth: register -> verify email -> login -> refresh
 * rotation/reuse -> logout, password reset, Google sign-in and the JWT guard.
 * Only external boundaries are faked: outgoing mail (to read the codes),
 * Cloudflare Turnstile and Google's token endpoint. MongoDB is real.
 */

const PUBLIC_USER_KEYS = [
  'accountVersion',
  'avatarUrl',
  'createdAt',
  'email',
  'fullName',
  'id',
  'role',
  'status',
  'updatedAt',
  'username',
].sort();

const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(32),
  tokenType: z.literal('Bearer'),
  accessTokenExpiresIn: z.number(),
  refreshTokenExpiresIn: z.number(),
  user: z.record(z.string(), z.unknown()),
});

const userIdSchema = z.object({ id: z.string() });

const errorSchema = z
  .object({
    statusCode: z.number(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type SentMail = { to: string; code: string; kind: 'verify' | 'reset' };

vi.setConfig({ testTimeout: 30_000 });

describe('Auth flows (e2e)', () => {
  let e2e: E2eApp;
  const sent: SentMail[] = [];
  const mail = {
    sendVerificationCode: vi.fn((to: string, code: string) => {
      sent.push({ to, code, kind: 'verify' });
      return Promise.resolve();
    }),
    sendPasswordResetCode: vi.fn((to: string, code: string) => {
      sent.push({ to, code, kind: 'reset' });
      return Promise.resolve();
    }),
  };
  const turnstile = { verify: vi.fn(() => Promise.resolve(true)) };
  const google = {
    authorize: vi.fn(),
    exchangeCode:
      vi.fn<(code: string, verifier: string) => Promise<GoogleProfileUser>>(),
  };
  const password = 'StrongPassword123!';
  let passwordHash: string;

  const server = () => e2e.app.getHttpServer();
  const users = () => e2e.mongo.connection.model<User>(User.name);
  const tokens = () =>
    e2e.mongo.connection.model<RefreshToken>(RefreshToken.name);
  const codes = () => e2e.mongo.connection.model<OneTimeCode>(OneTimeCode.name);

  const lastCode = (email: string, kind: SentMail['kind']): string => {
    for (let index = sent.length - 1; index >= 0; index -= 1) {
      const mailItem = sent[index];
      if (mailItem.to === email && mailItem.kind === kind) return mailItem.code;
    }
    throw new Error(`No ${kind} code was mailed to ${email}`);
  };
  const mailsTo = (email: string, kind: SentMail['kind']): number =>
    sent.filter((item) => item.to === email && item.kind === kind).length;

  const uniqueName = (prefix: string) =>
    `${prefix}.${randomUUID().slice(0, 8)}`;

  const register = (body: Record<string, unknown>) =>
    request(server()).post('/api/v1/auth/register').send(body);

  const verify = (email: string, code: string) =>
    request(server()).post('/api/v1/auth/verify-email').send({ email, code });

  const login = (username: string, secret: string = password) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ username, password: secret, turnstileToken: 'turnstile-ok' });

  const refresh = (refreshToken: string) =>
    request(server()).post('/api/v1/auth/refresh').send({ refreshToken });

  const logout = (refreshToken: string) =>
    request(server()).post('/api/v1/auth/logout').send({ refreshToken });

  const me = (accessToken: string) =>
    request(server()).get('/api/v1/auth/me').auth(accessToken, {
      type: 'bearer',
    });

  /** A verified, active password account created through the DB. */
  const activeUser = (fields: Partial<User> = {}) => {
    const name = uniqueName('flow');
    return createUser(e2e.mongo, {
      username: name,
      email: `${name}@vedora.test`,
      passwordHash,
      ...fields,
    });
  };

  /** Logs a verified user in and returns the parsed auth response. */
  const session = async (username: string) => {
    const response = await login(username).expect(200);
    return authResponseSchema.parse(response.body);
  };

  /** Registers through the API and verifies with the mailed code. */
  const registerAndVerify = async () => {
    const name = uniqueName('signup');
    const email = `${name}@vedora.test`;
    await register({
      username: name,
      email,
      password,
      fullName: 'Signup User',
    }).expect(201);
    const response = await verify(email, lastCode(email, 'verify')).expect(200);
    return { name, email, auth: authResponseSchema.parse(response.body) };
  };

  beforeAll(async () => {
    e2e = await createE2eApp('auth_flows_e2e', (builder) =>
      builder
        .overrideProvider(MailService)
        .useValue(mail)
        .overrideProvider(TurnstileService)
        .useValue(turnstile)
        .overrideProvider(GoogleOAuthService)
        .useValue(google),
    );
    passwordHash = await hashPassword(password);
  });

  beforeEach(() => {
    sent.length = 0;
    mail.sendVerificationCode.mockClear();
    mail.sendPasswordResetCode.mockClear();
    google.exchangeCode.mockReset();
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('POST /auth/register', () => {
    it('returns only the normalized email and issues no session', async () => {
      const name = uniqueName('reg');
      const response = await register({
        username: `  ${name.toUpperCase()}  `,
        email: `  ${name.toUpperCase()}@Vedora.TEST `,
        password,
        fullName: '  Reg User  ',
      }).expect(201);

      expect(response.body).toEqual({ email: `${name}@vedora.test` });
      const stored = await users().findOne({ username: name }).exec();
      expect(stored).toMatchObject({
        email: `${name}@vedora.test`,
        fullName: 'Reg User',
        status: AccountStatus.PENDING_EMAIL,
        role: UserRole.USER,
        emailVerifiedAt: null,
      });
      expect(await tokens().countDocuments({ userId: stored?.id })).toBe(0);
    });

    it('emails a verification code to the new address', async () => {
      const name = uniqueName('reg');
      await register({
        username: name,
        email: `${name}@vedora.test`,
        password,
        fullName: 'Reg User',
      }).expect(201);

      expect(lastCode(`${name}@vedora.test`, 'verify')).toMatch(/^\d{6}$/);
    });

    it.each([
      ['username shorter than 3', { username: 'ab' }],
      ['username longer than 30', { username: 'a'.repeat(31) }],
      ['username with forbidden characters', { username: 'bad@name' }],
      ['password shorter than 8', { password: 'Short1!' }],
      ['password longer than 72 characters', { password: 'a'.repeat(73) }],
      ['whitespace-only full name', { fullName: '   ' }],
      ['malformed email', { email: 'not-an-email' }],
      ['an undeclared role field', { role: 'ADMIN' }],
      ['an undeclared status field', { status: 'ACTIVE' }],
    ])('rejects %s with VALIDATION_FAILED', async (_case, override) => {
      const name = uniqueName('bad');
      const response = await register({
        username: name,
        email: `${name}@vedora.test`,
        password,
        fullName: 'Bad Input',
        ...override,
      }).expect(400);

      expect(errorSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('accepts the 8-character and 72-character password boundaries', async () => {
      for (const secret of ['a'.repeat(8), 'b'.repeat(72)]) {
        const name = uniqueName('edge');
        await register({
          username: name,
          email: `${name}@vedora.test`,
          password: secret,
          fullName: 'Edge User',
        }).expect(201);
      }
    });

    it('rejects a 72-character password that exceeds 72 UTF-8 bytes', async () => {
      const name = uniqueName('bytes');
      const response = await register({
        username: name,
        email: `${name}@vedora.test`,
        password: 'é'.repeat(72),
        fullName: 'Bytes User',
      }).expect(400);

      expect(errorSchema.parse(response.body).code).toBe('BAD_REQUEST');
    });

    it('rejects an email already used by a verified account, ignoring case', async () => {
      const existing = await activeUser();
      const response = await register({
        username: uniqueName('dup'),
        email: existing.email.toUpperCase(),
        password,
        fullName: 'Dup User',
      }).expect(409);

      expect(errorSchema.parse(response.body).code).toBe('CONFLICT');
    });

    it('rejects a username already taken, ignoring case', async () => {
      const existing = await activeUser();
      await register({
        username: existing.username.toUpperCase(),
        email: `${uniqueName('dup')}@vedora.test`,
        password,
        fullName: 'Dup User',
      }).expect(409);
    });

    it('keeps a fresh unverified account and refuses to register over it', async () => {
      const name = uniqueName('fresh');
      await register({
        username: name,
        email: `${name}@vedora.test`,
        password,
        fullName: 'First',
      }).expect(201);

      await register({
        username: uniqueName('other'),
        email: `${name}@vedora.test`,
        password,
        fullName: 'Second',
      }).expect(409);
    });

    it('replaces an unverified account older than one hour with the same email', async () => {
      const name = uniqueName('stale');
      const email = `${name}@vedora.test`;
      await register({
        username: name,
        email,
        password,
        fullName: 'Stale',
      }).expect(201);
      await e2e.mongo.connection
        .collection('users')
        .updateOne(
          { email },
          { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } },
        );

      const newName = uniqueName('claim');
      await register({
        username: newName,
        email,
        password,
        fullName: 'Claimer',
      }).expect(201);

      const stored = await users().find({ email }).exec();
      expect(stored.map((user) => user.username)).toEqual([newName]);
    });

    it('lets only one of two parallel registrations claim a username', async () => {
      const name = uniqueName('race');
      const attempt = (suffix: string) =>
        register({
          username: name,
          email: `${name}.${suffix}@vedora.test`,
          password,
          fullName: 'Racer',
        });

      const results = await Promise.all([attempt('a'), attempt('b')]);

      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(await users().countDocuments({ username: name })).toBe(1);
    });
  });

  describe('POST /auth/verify-email', () => {
    const pendingAccount = async () => {
      const name = uniqueName('pend');
      const email = `${name}@vedora.test`;
      await register({
        username: name,
        email,
        password,
        fullName: 'Pending User',
      }).expect(201);
      return { name, email, code: lastCode(email, 'verify') };
    };
    const wrongCode = (code: string) =>
      code === '000000' ? '111111' : '000000';

    it('activates the account and returns a token pair with only public user fields', async () => {
      const { email, code } = await pendingAccount();

      const response = await verify(email, code).expect(200);

      const auth = authResponseSchema.parse(response.body);
      expect(Object.keys(auth.user).sort()).toEqual(PUBLIC_USER_KEYS);
      expect(auth.user).toMatchObject({ status: AccountStatus.ACTIVE, email });
      await me(auth.accessToken).expect(200);
    });

    it('accepts the email in any case or padding', async () => {
      const { email, code } = await pendingAccount();

      await verify(`  ${email.toUpperCase()} `, code).expect(200);
    });

    it('refuses to use the same code twice', async () => {
      const { email, code } = await pendingAccount();
      await verify(email, code).expect(200);

      const response = await verify(email, code).expect(400);

      expect(errorSchema.parse(response.body).code).toBe('BAD_REQUEST');
    });

    // BUG-1: Email verification code can be redeemed twice concurrently
    it('lets only one of two parallel submissions of the same code issue tokens', async () => {
      const { email, code } = await pendingAccount();

      const results = await Promise.all([
        verify(email, code),
        verify(email, code),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    });

    it('rejects a wrong code and keeps the account pending', async () => {
      const { name, email, code } = await pendingAccount();

      await verify(email, wrongCode(code)).expect(400);

      const stored = await users().findOne({ username: name }).exec();
      expect(stored).toMatchObject({
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
    });

    it('burns the code after five wrong attempts', async () => {
      const { email, code } = await pendingAccount();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await verify(email, wrongCode(code)).expect(400);
      }

      await verify(email, code).expect(400);
    });

    it('rejects an expired code', async () => {
      const { name, email, code } = await pendingAccount();
      const owner = await users().findOne({ username: name }).exec();
      await codes().updateMany(
        { userId: owner?.id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );

      await verify(email, code).expect(400);
    });

    it('locks the email with 429 after fifteen guesses in a day', async () => {
      const { email, code } = await pendingAccount();
      for (let guess = 0; guess < 15; guess += 1) {
        await verify(email, wrongCode(code)).expect(400);
      }

      const response = await verify(email, code).expect(429);

      expect(errorSchema.parse(response.body).code).toBe(
        'VERIFY_LIMIT_REACHED',
      );
    });

    it('answers an unknown email exactly like a wrong code', async () => {
      const response = await verify(
        `${uniqueName('ghost')}@vedora.test`,
        '123456',
      ).expect(400);

      expect(errorSchema.parse(response.body)).toEqual({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'Invalid or expired verification code',
      });
    });

    it.each(['12345', '1234567', 'abcdef', ''])(
      'rejects the malformed code %j with VALIDATION_FAILED',
      async (code) => {
        await verify('someone@vedora.test', code).expect(400);
      },
    );
  });

  describe('POST /auth/verify-email/resend', () => {
    it('answers 204 for an unknown email without sending mail', async () => {
      const email = `${uniqueName('ghost')}@vedora.test`;

      await request(server())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email })
        .expect(204);

      expect(mailsTo(email, 'verify')).toBe(0);
    });

    it('answers 204 for a verified email without sending mail', async () => {
      const user = await activeUser();

      await request(server())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email: user.email })
        .expect(204);

      expect(mailsTo(user.email, 'verify')).toBe(0);
    });

    it('does not send a second code inside the two-minute cooldown', async () => {
      const name = uniqueName('cool');
      const email = `${name}@vedora.test`;
      await register({
        username: name,
        email,
        password,
        fullName: 'Cool',
      }).expect(201);

      await request(server())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email })
        .expect(204);

      expect(mailsTo(email, 'verify')).toBe(1);
    });
  });

  describe('POST /auth/login', () => {
    it('logs a verified user in regardless of username case and padding', async () => {
      const user = await activeUser();

      const response = await login(`  ${user.username.toUpperCase()} `).expect(
        200,
      );

      const auth = authResponseSchema.parse(response.body);
      expect(auth.user).toMatchObject({ id: user.id });
      expect(Object.keys(auth.user).sort()).toEqual(PUBLIC_USER_KEYS);
    });

    it('answers a wrong password and an unknown username with the same 401', async () => {
      const user = await activeUser();

      const wrong = await login(user.username, 'WrongPassword1!').expect(401);
      const unknown = await login(uniqueName('ghost')).expect(401);

      expect(errorSchema.parse(wrong.body)).toEqual(
        errorSchema.parse(unknown.body),
      );
      expect(errorSchema.parse(wrong.body).code).toBe('UNAUTHORIZED');
    });

    it('sends a code and answers 403 EMAIL_NOT_VERIFIED for a pending account with the right password', async () => {
      const user = await activeUser({
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });

      const response = await login(user.username).expect(403);

      expect(errorSchema.parse(response.body)).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
        details: { email: user.email },
      });
      expect(mailsTo(user.email, 'verify')).toBe(1);
      expect(await tokens().countDocuments({ userId: user.id })).toBe(0);
    });

    it('does not reveal a pending account to a wrong password', async () => {
      const user = await activeUser({
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });

      const response = await login(user.username, 'WrongPassword1!').expect(
        401,
      );

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
      expect(mailsTo(user.email, 'verify')).toBe(0);
    });

    it('answers 401 ACCOUNT_SUSPENDED for a suspended account with the right password', async () => {
      const user = await activeUser({ status: AccountStatus.SUSPENDED });

      const response = await login(user.username).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('ACCOUNT_SUSPENDED');
      expect(await tokens().countDocuments({ userId: user.id })).toBe(0);
    });

    it('answers a suspended account with a wrong password like any bad credential', async () => {
      const user = await activeUser({ status: AccountStatus.SUSPENDED });

      const response = await login(user.username, 'WrongPassword1!').expect(
        401,
      );

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    it('rejects any password for a Google-only account', async () => {
      const user = await activeUser({
        passwordHash: null,
        googleId: randomUUID(),
      });

      const response = await login(user.username).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    // BUG-2: Login accepts a different password that shares the first 72 bytes
    it('rejects a password that only matches the stored one in its first 72 bytes', async () => {
      const stored = `${'a'.repeat(70)}é`;
      const user = await activeUser({
        passwordHash: await hashPassword(stored),
      });
      await login(user.username, stored).expect(200);

      await login(user.username, `${stored}X`).expect(401);
    });

    it('refuses to log in when Turnstile rejects the token, before checking credentials', async () => {
      const user = await activeUser({
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
      turnstile.verify.mockResolvedValueOnce(false);

      const response = await login(user.username).expect(403);

      expect(errorSchema.parse(response.body).code).toBe('CAPTCHA_FAILED');
      expect(mailsTo(user.email, 'verify')).toBe(0);
    });
  });

  describe('POST /auth/refresh and /auth/logout', () => {
    it('rotates the refresh token and returns a working access token', async () => {
      const user = await activeUser();
      const first = await session(user.username);

      const response = await refresh(first.refreshToken).expect(200);

      const second = authResponseSchema.parse(response.body);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(Object.keys(second.user).sort()).toEqual(PUBLIC_USER_KEYS);
      await me(second.accessToken).expect(200);
    });

    it('rejects a rotated refresh token', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      await refresh(first.refreshToken).expect(200);

      const response = await refresh(first.refreshToken).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    it('revokes the live descendant when a rotated token is reused', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      const second = authResponseSchema.parse(
        (await refresh(first.refreshToken).expect(200)).body,
      );

      await refresh(first.refreshToken).expect(401);

      await refresh(second.refreshToken).expect(401);
    });

    it('keeps other sessions alive when one family is reused', async () => {
      const user = await activeUser();
      const phone = await session(user.username);
      const laptop = await session(user.username);
      await refresh(phone.refreshToken).expect(200);
      await refresh(phone.refreshToken).expect(401);

      await refresh(laptop.refreshToken).expect(200);
    });

    it('lets at most one of two parallel refreshes with the same token succeed', async () => {
      const user = await activeUser();
      const first = await session(user.username);

      const results = await Promise.all([
        refresh(first.refreshToken),
        refresh(first.refreshToken),
      ]);

      const successes = results.filter((result) => result.status === 200);
      expect(successes.length).toBeLessThanOrEqual(1);
      expect(results.every((r) => [200, 401].includes(r.status))).toBe(true);
    });

    it('rejects an expired refresh token', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      await tokens().updateMany(
        { userId: user.id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );

      const response = await refresh(first.refreshToken).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    it('rejects an unknown refresh token with 401', async () => {
      await refresh('x'.repeat(64)).expect(401);
    });

    it('rejects a refresh token shorter than 32 characters with 400', async () => {
      await refresh('short').expect(400);
    });

    it('rejects refresh for an account that was deleted', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      await e2e.mongo.withTransaction((dbSession) =>
        users().deleteOne({ _id: user.id }, { session: dbSession }).exec(),
      );

      await refresh(first.refreshToken).expect(401);
    });

    it('reflects the current role in the refreshed user', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      await users().updateOne({ _id: user.id }, { role: UserRole.ADMIN });

      const response = await refresh(first.refreshToken).expect(200);

      expect(authResponseSchema.parse(response.body).user.role).toBe(
        UserRole.ADMIN,
      );
    });

    it('logs out one family and leaves other devices signed in', async () => {
      const user = await activeUser();
      const phone = await session(user.username);
      const laptop = await session(user.username);

      await logout(phone.refreshToken).expect(204);

      await refresh(phone.refreshToken).expect(401);
      await refresh(laptop.refreshToken).expect(200);
    });

    it('logs out the rotated descendant along with its family', async () => {
      const user = await activeUser();
      const first = await session(user.username);
      const second = authResponseSchema.parse(
        (await refresh(first.refreshToken).expect(200)).body,
      );

      await logout(first.refreshToken).expect(204);

      await refresh(second.refreshToken).expect(401);
    });

    it('treats logout as idempotent, including unknown tokens', async () => {
      const user = await activeUser();
      const first = await session(user.username);

      await logout(first.refreshToken).expect(204);
      await logout(first.refreshToken).expect(204);
      await logout('y'.repeat(64)).expect(204);
    });
  });

  describe('password reset', () => {
    const forgot = (email: string) =>
      request(server()).post('/api/v1/auth/password/forgot').send({ email });
    const reset = (email: string, code: string, newPassword: string) =>
      request(server())
        .post('/api/v1/auth/password/reset')
        .send({ email, code, password: newPassword });
    const newPassword = 'BrandNewPassword456!';

    it('answers 204 for an unknown email without sending mail', async () => {
      const email = `${uniqueName('ghost')}@vedora.test`;

      await forgot(email).expect(204);

      expect(mailsTo(email, 'reset')).toBe(0);
    });

    it('replaces the password: the old one fails and the new one works', async () => {
      const user = await activeUser();
      await forgot(user.email).expect(204);

      await reset(
        user.email,
        lastCode(user.email, 'reset'),
        newPassword,
      ).expect(204);

      await login(user.username, password).expect(401);
      await login(user.username, newPassword).expect(200);
    });

    it('signs out every existing refresh session', async () => {
      const user = await activeUser();
      const phone = await session(user.username);
      const laptop = await session(user.username);
      await forgot(user.email).expect(204);

      await reset(
        user.email,
        lastCode(user.email, 'reset'),
        newPassword,
      ).expect(204);

      await refresh(phone.refreshToken).expect(401);
      await refresh(laptop.refreshToken).expect(401);
    });

    it('refuses to use the same reset code twice', async () => {
      const user = await activeUser();
      await forgot(user.email).expect(204);
      const code = lastCode(user.email, 'reset');
      await reset(user.email, code, newPassword).expect(204);

      await reset(user.email, code, 'AnotherPassword789!').expect(400);

      await login(user.username, newPassword).expect(200);
    });

    it('rejects a wrong code and keeps the old password', async () => {
      const user = await activeUser();
      await forgot(user.email).expect(204);
      const code = lastCode(user.email, 'reset');

      const response = await reset(
        user.email,
        code === '000000' ? '111111' : '000000',
        newPassword,
      ).expect(400);

      expect(errorSchema.parse(response.body).code).toBe('BAD_REQUEST');
      await login(user.username, password).expect(200);
    });

    it('rejects a new password over 72 UTF-8 bytes without consuming the code', async () => {
      const user = await activeUser();
      await forgot(user.email).expect(204);
      const code = lastCode(user.email, 'reset');

      await reset(user.email, code, 'é'.repeat(72)).expect(400);

      await reset(user.email, code, newPassword).expect(204);
    });

    it('lets a pending account finish sign-up through a reset', async () => {
      const user = await activeUser({
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
      await forgot(user.email).expect(204);

      await reset(
        user.email,
        lastCode(user.email, 'reset'),
        newPassword,
      ).expect(204);

      await login(user.username, newPassword).expect(200);
    });

    it('keeps a suspended account suspended after a reset', async () => {
      const user = await activeUser({ status: AccountStatus.SUSPENDED });
      await forgot(user.email).expect(204);

      await reset(
        user.email,
        lastCode(user.email, 'reset'),
        newPassword,
      ).expect(204);

      const response = await login(user.username, newPassword).expect(401);
      expect(errorSchema.parse(response.body).code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('POST /auth/google', () => {
    const exchange = () =>
      request(server())
        .post('/api/v1/auth/google')
        .send({ code: 'google-code', codeVerifier: 'v'.repeat(43) });
    const googleProfile = (email: string): GoogleProfileUser => ({
      googleId: randomUUID(),
      email,
      fullName: 'Google User',
    });

    it('creates an ACTIVE USER account for a new Google identity', async () => {
      const email = `${uniqueName('g')}@gmail.test`;
      google.exchangeCode.mockResolvedValue(googleProfile(email));

      const response = await exchange().expect(200);

      const auth = authResponseSchema.parse(response.body);
      expect(auth.user).toMatchObject({
        email,
        role: UserRole.USER,
        status: AccountStatus.ACTIVE,
      });
      expect(Object.keys(auth.user).sort()).toEqual(PUBLIC_USER_KEYS);
    });

    it('signs the same Google identity into the same account every time', async () => {
      google.exchangeCode.mockResolvedValue(
        googleProfile(`${uniqueName('g')}@gmail.test`),
      );

      const first = authResponseSchema.parse(
        (await exchange().expect(200)).body,
      );
      const second = authResponseSchema.parse(
        (await exchange().expect(200)).body,
      );

      expect(second.user.id).toBe(first.user.id);
    });

    it('links Google to a verified password account and keeps its password', async () => {
      const user = await activeUser();
      google.exchangeCode.mockResolvedValue(googleProfile(user.email));

      const response = await exchange().expect(200);

      expect(
        userIdSchema.parse(authResponseSchema.parse(response.body).user).id,
      ).toBe(user.id);
      await login(user.username).expect(200);
    });

    it('refuses a suspended account matched by email and does not link it', async () => {
      const user = await activeUser({ status: AccountStatus.SUSPENDED });
      google.exchangeCode.mockResolvedValue(googleProfile(user.email));

      const response = await exchange().expect(401);

      expect(errorSchema.parse(response.body).code).toBe('ACCOUNT_SUSPENDED');
      const stored = await users().findOne({ _id: user.id }).exec();
      expect(stored?.googleId).toBeNull();
    });

    it('answers 401 when Google rejects the code', async () => {
      google.exchangeCode.mockRejectedValue(
        new UnauthenticatedException('UNAUTHORIZED', 'Google sign-in failed'),
      );

      const response = await exchange().expect(401);

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    it('rejects a malformed PKCE verifier before calling Google', async () => {
      await request(server())
        .post('/api/v1/auth/google')
        .send({ code: 'google-code', codeVerifier: 'short' })
        .expect(400);

      expect(google.exchangeCode).not.toHaveBeenCalled();
    });

    // BUG-3: PATCH /users/:id changes the email without re-verification
    it('never signs a Google user into an account that only claimed their email without verifying it', async () => {
      const attacker = await registerAndVerify();
      const victimEmail = `${uniqueName('victim')}@gmail.test`;
      await request(server())
        .patch(`/api/v1/users/${userIdSchema.parse(attacker.auth.user).id}`)
        .auth(attacker.auth.accessToken, { type: 'bearer' })
        .send({ email: victimEmail });
      google.exchangeCode.mockResolvedValue(googleProfile(victimEmail));

      const response = await exchange();

      const signedInAs =
        response.status === 200
          ? userIdSchema.parse(authResponseSchema.parse(response.body).user).id
          : null;
      expect(signedInAs).not.toBe(attacker.auth.user.id);
    });
  });

  describe('JWT guard on GET /auth/me', () => {
    const jwt = () => e2e.app.get(JwtService);

    it('returns only public fields for the current user', async () => {
      const user = await activeUser();
      const { accessToken } = await session(user.username);

      const response = await me(accessToken).expect(200);

      expect(
        Object.keys(
          z.record(z.string(), z.unknown()).parse(response.body),
        ).sort(),
      ).toEqual(PUBLIC_USER_KEYS);
    });

    it('accepts a lowercase bearer scheme', async () => {
      const user = await activeUser();
      const { accessToken } = await session(user.username);

      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `bearer ${accessToken}`)
        .expect(200);
    });

    it('rejects an expired access token with the error envelope', async () => {
      const user = await activeUser();
      const expired = await jwt().signAsync(
        { sub: user.id, username: user.username },
        { expiresIn: -10 },
      );

      const response = await me(expired).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    });

    it('rejects a token signed with another secret', async () => {
      const user = await activeUser();
      const forged = await new JwtService({
        secret: 'a-completely-different-secret-of-32-chars!',
      }).signAsync({ sub: user.id, username: user.username });

      await me(forged).expect(401);
    });

    it('rejects a valid token after the account was deleted', async () => {
      const user = await activeUser();
      const { accessToken } = await session(user.username);
      await e2e.mongo.withTransaction((dbSession) =>
        users().deleteOne({ _id: user.id }, { session: dbSession }).exec(),
      );

      await me(accessToken).expect(401);
    });

    it('rejects a valid token once the account is suspended', async () => {
      const user = await activeUser();
      const { accessToken } = await session(user.username);
      await users().updateOne(
        { _id: user.id },
        { status: AccountStatus.SUSPENDED },
      );

      const response = await me(accessToken).expect(401);

      expect(errorSchema.parse(response.body).code).toBe('ACCOUNT_SUSPENDED');
    });

    it('rejects a token without a bearer scheme', async () => {
      const user = await activeUser();
      const { accessToken } = await session(user.username);

      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', accessToken)
        .expect(401);
    });
  });
});
