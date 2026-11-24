import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import {
  AccountStatus,
  RefreshToken,
  User,
  UserAccountAudit,
  UserRole,
} from '@src/mongo/models.js';
import { RefreshTokensService } from '@src/auth/refresh-tokens.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

/**
 * Black-box flows for /users account management: self-service edits,
 * admin CRUD, status/role transitions, last-admin protection under
 * concurrency, and what deleting an account does to its sessions.
 */

const errorSchema = z
  .object({
    statusCode: z.number(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string(),
  email: z.string(),
  role: z.enum(UserRole),
  status: z.enum(AccountStatus),
  accountVersion: z.number(),
});

vi.setConfig({ testTimeout: 30_000 });

describe('Account management flows (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let admin: User;
  let userToken: string;
  let adminToken: string;

  const server = () => e2e.app.getHttpServer();
  const users = () => e2e.mongo.connection.model<User>(User.name);
  const tokens = () =>
    e2e.mongo.connection.model<RefreshToken>(RefreshToken.name);
  const audits = () =>
    e2e.mongo.connection.model<UserAccountAudit>(UserAccountAudit.name);
  const stored = async (id: string) => {
    const found = await users().findOne({ _id: id }).exec();
    if (!found) throw new Error(`User ${id} is missing`);
    return found;
  };

  const patchUser = (
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .patch(`/api/v1/users/${id}`)
      .auth(token, { type: 'bearer' })
      .send(body);

  const setStatus = (
    token: string,
    id: string,
    status: string,
    expectedVersion: unknown = 0,
  ) =>
    request(server())
      .patch(`/api/v1/users/${id}/status`)
      .auth(token, { type: 'bearer' })
      .send({ status, expectedVersion, reason: 'Flow test' });

  const setRole = (token: string, id: string, role: string, version = 0) =>
    request(server())
      .patch(`/api/v1/users/${id}/role`)
      .auth(token, { type: 'bearer' })
      .send({ role, expectedVersion: version, reason: 'Flow test' });

  beforeAll(async () => {
    e2e = await createE2eApp('users_flows_e2e');
  });

  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      users().deleteMany({}, { session }).exec(),
    );
    await audits().deleteMany({});
    user = await createUser(e2e.mongo, { username: 'flow.user' });
    admin = await createUser(e2e.mongo, {
      username: 'flow.admin',
      role: UserRole.ADMIN,
    });
    [userToken, adminToken] = await Promise.all([
      e2e.sign(user),
      e2e.sign(admin),
    ]);
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('PATCH /users/:id', () => {
    // BUG-4: PATCH /users/:id persists null into required username/email/fullName
    it.each([
      ['email', { email: null }],
      ['fullName', { fullName: null }],
      ['username', { username: null }],
    ])(
      'rejects null for the required field %s with 400 and keeps the account intact',
      async (_field, body) => {
        const response = await patchUser(userToken, user.id, body);

        expect(response.status).toBe(400);
        expect(await stored(user.id)).toMatchObject({
          email: user.email,
          fullName: user.fullName,
          username: user.username,
        });
      },
    );

    it('treats an empty body as a no-op', async () => {
      const response = await patchUser(userToken, user.id, {}).expect(200);

      expect(userSchema.parse(response.body)).toMatchObject({
        id: user.id,
        username: user.username,
        email: user.email,
      });
    });

    it('normalizes a new username to trimmed lowercase', async () => {
      const response = await patchUser(userToken, user.id, {
        username: '  New.Name ',
      }).expect(200);

      expect(userSchema.parse(response.body).username).toBe('new.name');
    });

    it('rejects changing email through profile updates with 400 VALIDATION_FAILED', async () => {
      const other = await createUser(e2e.mongo, { username: 'flow.other' });

      const response = await patchUser(userToken, user.id, {
        email: other.email.toUpperCase(),
      }).expect(400);

      expect(errorSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      expect(await stored(user.id)).toMatchObject({ email: user.email });
    });

    it('rejects a whitespace-only full name', async () => {
      await patchUser(userToken, user.id, { fullName: '   ' }).expect(400);
    });

    it('never returns credentials or Google identifiers', async () => {
      await users().updateOne(
        { _id: user.id },
        { passwordHash: 'secret-hash', googleId: 'google-sub' },
      );

      const response = await patchUser(userToken, user.id, {
        fullName: 'Renamed',
      }).expect(200);

      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body).not.toHaveProperty('googleId');
    });

    it('answers 404 to an admin editing an unknown account', async () => {
      await patchUser(adminToken, randomUUID(), { fullName: 'X' }).expect(404);
    });

    it('answers 403 to a user editing an unknown account before any lookup', async () => {
      await patchUser(userToken, randomUUID(), { fullName: 'X' }).expect(403);
    });

    it('rejects a non-UUID id with 400', async () => {
      await patchUser(userToken, 'not-a-uuid', { fullName: 'X' }).expect(400);
    });
  });

  describe('GET /users', () => {
    it('answers 404 to an admin reading an unknown account', async () => {
      await request(server())
        .get(`/api/v1/users/${randomUUID()}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
    });

    it.each([
      ['limit=0', '?limit=0'],
      ['limit=51', '?limit=51'],
      ['page=0', '?page=0'],
      ['an unknown status', '?status=BANNED'],
      ['a 101-character search', `?q=${'a'.repeat(101)}`],
    ])('rejects %s with 400', async (_case, query) => {
      await request(server())
        .get(`/api/v1/users${query}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(400);
    });

    it('lists accounts without credentials', async () => {
      await users().updateOne({ _id: user.id }, { passwordHash: 'secret' });

      const response = await request(server())
        .get('/api/v1/users')
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      expect(JSON.stringify(response.body)).not.toContain('secret');
    });

    it('treats regex characters in the search as literal text', async () => {
      const response = await request(server())
        .get('/api/v1/users?q=.*')
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      expect(
        z.object({ items: z.array(z.unknown()) }).parse(response.body).items,
      ).toHaveLength(0);
    });
  });

  describe('POST /users (admin)', () => {
    const newAccount = {
      username: 'created.user',
      fullName: 'Created User',
      email: 'created@vedora.test',
      password: 'StrongPassword123!',
    };

    it('creates a pending USER account that cannot be used before email verification', async () => {
      const response = await request(server())
        .post('/api/v1/users')
        .auth(adminToken, { type: 'bearer' })
        .send(newAccount)
        .expect(201);

      expect(userSchema.parse(response.body)).toMatchObject({
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
      });
    });

    it('rejects a duplicate username with 409', async () => {
      await request(server())
        .post('/api/v1/users')
        .auth(adminToken, { type: 'bearer' })
        .send({ ...newAccount, username: user.username })
        .expect(409);
    });
  });

  describe('DELETE /users/:id', () => {
    it('ends the deleted account sessions: access and refresh tokens stop working', async () => {
      const refreshTokens = e2e.app.get(RefreshTokensService);
      const issued = await refreshTokens.issue(user.id);

      await request(server())
        .delete(`/api/v1/users/${user.id}`)
        .auth(userToken, { type: 'bearer' })
        .expect(204);

      await request(server())
        .get('/api/v1/auth/me')
        .auth(userToken, { type: 'bearer' })
        .expect(401);
      await request(server())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: issued.token })
        .expect(401);
      expect(await tokens().countDocuments({ userId: user.id })).toBe(0);
    });

    it('lets an admin delete another account once; the second delete is 404', async () => {
      await request(server())
        .delete(`/api/v1/users/${user.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(204);

      await request(server())
        .delete(`/api/v1/users/${user.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
    });

    it('refuses to delete the last ACTIVE admin, even by themselves', async () => {
      const response = await request(server())
        .delete(`/api/v1/users/${admin.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(409);

      expect(errorSchema.parse(response.body).code).toBe('LAST_ACTIVE_ADMIN');
    });

    it('writes a deletion audit with the system reason', async () => {
      await request(server())
        .delete(`/api/v1/users/${user.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(204);

      expect(
        await audits().findOne({ userId: user.id }).lean().exec(),
      ).toMatchObject({
        actorId: admin.id,
        reason: 'Account deletion requested',
        status: AccountStatus.DELETED,
      });
    });
  });

  describe('PATCH /users/:id/status', () => {
    it('suspends and reactivates, bumping the version once per change', async () => {
      const suspended = await setStatus(
        adminToken,
        user.id,
        AccountStatus.SUSPENDED,
        0,
      ).expect(200);
      expect(userSchema.parse(suspended.body)).toMatchObject({
        status: AccountStatus.SUSPENDED,
        accountVersion: 1,
      });

      const reactivated = await setStatus(
        adminToken,
        user.id,
        AccountStatus.ACTIVE,
        1,
      ).expect(200);
      expect(userSchema.parse(reactivated.body)).toMatchObject({
        status: AccountStatus.ACTIVE,
        accountVersion: 2,
      });
    });

    it('locks the suspended user out of authenticated routes immediately', async () => {
      await setStatus(adminToken, user.id, AccountStatus.SUSPENDED).expect(200);

      const response = await request(server())
        .get('/api/v1/auth/me')
        .auth(userToken, { type: 'bearer' })
        .expect(401);

      expect(errorSchema.parse(response.body).code).toBe('ACCOUNT_SUSPENDED');
    });

    it.each([
      ['a numeric string version', AccountStatus.SUSPENDED, '0'],
      ['a negative version', AccountStatus.SUSPENDED, -1],
      ['a fractional version', AccountStatus.SUSPENDED, 0.5],
      ['the DELETED status', AccountStatus.DELETED, 0],
      ['the PENDING_EMAIL status', AccountStatus.PENDING_EMAIL, 0],
    ])('rejects %s with 400', async (_case, status, version) => {
      await setStatus(adminToken, user.id, status, version).expect(400);
    });

    it('rejects a whitespace-only reason with 400', async () => {
      await request(server())
        .patch(`/api/v1/users/${user.id}/status`)
        .auth(adminToken, { type: 'bearer' })
        .send({
          status: AccountStatus.SUSPENDED,
          expectedVersion: 0,
          reason: '   ',
        })
        .expect(400);
    });

    it('answers 404 for an unknown account', async () => {
      await setStatus(adminToken, randomUUID(), AccountStatus.SUSPENDED).expect(
        404,
      );
    });

    it('lets at most one of two admins suspend the other at the same time', async () => {
      const second = await createUser(e2e.mongo, {
        username: 'flow.admin2',
        role: UserRole.ADMIN,
      });
      const secondToken = await e2e.sign(second);

      const results = await Promise.all([
        setStatus(adminToken, second.id, AccountStatus.SUSPENDED),
        setStatus(secondToken, admin.id, AccountStatus.SUSPENDED),
      ]);

      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(
        await users().countDocuments({
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
        }),
      ).toBe(1);
    });
  });

  describe('PATCH /users/:id/role', () => {
    it('lets at most one of two admins demote themselves at the same time', async () => {
      const second = await createUser(e2e.mongo, {
        username: 'flow.admin2',
        role: UserRole.ADMIN,
      });
      const secondToken = await e2e.sign(second);

      const results = await Promise.all([
        setRole(adminToken, admin.id, UserRole.USER),
        setRole(secondToken, second.id, UserRole.USER),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(
        await users().countDocuments({
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
        }),
      ).toBe(1);
    });

    it('returns the account unchanged, without a version bump, when the role is the same', async () => {
      const response = await setRole(adminToken, user.id, UserRole.USER).expect(
        200,
      );

      expect(userSchema.parse(response.body).accountVersion).toBe(0);
      expect(await audits().countDocuments({ userId: user.id })).toBe(0);
    });

    it('promotes a user who can then use admin routes with the same token', async () => {
      await setRole(adminToken, user.id, UserRole.ADMIN).expect(200);

      await request(server())
        .get('/api/v1/users')
        .auth(userToken, { type: 'bearer' })
        .expect(200);
    });

    it('rejects an unknown role with 400', async () => {
      await setRole(adminToken, user.id, 'SUPERADMIN').expect(400);
    });
  });
});
