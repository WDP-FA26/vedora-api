import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { User, UserAccountAudit, UserRole } from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createUser } from './fixtures.js';

/** An `id` from a response body, without trusting its shape. */
function responseId(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'id' in body
    ? body.id
    : undefined;
}

describe('Account permissions (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let admin: User;
  let other: User;
  let userToken: string;
  let adminToken: string;
  const profile = { fullName: 'Updated Name' };
  const signup = {
    username: 'new.user',
    fullName: 'New User',
    email: 'new@vedora.vn',
    password: 'StrongPassword123!',
  };

  const server = () => e2e.app.getHttpServer();
  const jwt = () => e2e.app.get(JwtService);
  const users = () => e2e.mongo.connection.model<User>(User.name);
  const audits = () =>
    e2e.mongo.connection.model<UserAccountAudit>(UserAccountAudit.name);
  const countUsers = () => users().countDocuments();
  const storedUser = async (id: string) => {
    const stored = await users().findOne({ _id: id }).exec();
    if (!stored) throw new Error(`User ${id} is missing`);
    return stored;
  };

  beforeAll(async () => {
    e2e = await createE2eApp('users_e2e');
  });
  beforeEach(async () => {
    // Start from the same three accounts. Tokens deliberately have no role
    // claim: the database decides their current permissions.
    await e2e.mongo.withTransaction((session) =>
      users().deleteMany({}, { session }).exec(),
    );
    await audits().deleteMany({});
    await e2e.mongo.connection.collections.refresh_tokens.deleteMany({});
    user = await createUser(e2e.mongo, { username: 'vedora.user' });
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    other = await createUser(e2e.mongo, { username: 'vedora.other' });
    [userToken, adminToken] = await Promise.all([
      e2e.sign(user),
      e2e.sign(admin),
    ]);
  });
  afterAll(async () => {
    await e2e.close();
  });

  it('requires authentication to list accounts', async () => {
    await request(server()).get('/api/v1/users').expect(401);
  });

  it('rejects invalid JWTs', async () => {
    await request(server())
      .get('/api/v1/users')
      .auth('invalid-token', { type: 'bearer' })
      .expect(401);
  });

  it('rejects malformed account IDs in signed JWTs', async () => {
    const token = await jwt().signAsync({
      sub: 'invalid-id',
      username: 'vedora.user',
    });
    await request(server())
      .get('/api/v1/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
  });

  it('prevents ordinary users from listing accounts', async () => {
    await request(server())
      .get('/api/v1/users')
      .auth(userToken, { type: 'bearer' })
      .expect(403);
  });

  it('prevents ordinary users from creating accounts through admin CRUD', async () => {
    await request(server())
      .post('/api/v1/users')
      .auth(userToken, { type: 'bearer' })
      .send(signup)
      .expect(403);
    expect(await countUsers()).toBe(3);
  });

  it.each([
    ['get', undefined],
    ['patch', profile],
    ['delete', undefined],
  ] as const)(
    'prevents users from calling %s on someone else',
    async (method, body) => {
      const operation = request(server())
        [method](`/api/v1/users/${other.id}`)
        .auth(userToken, { type: 'bearer' });
      if (body) operation.send(body);
      await operation.expect(403);
      expect(await storedUser(other.id)).toMatchObject({
        fullName: other.fullName,
      });
    },
  );

  it.each([
    ['get', 200, undefined],
    ['patch', 200, profile],
    ['delete', 204, undefined],
  ] as const)(
    'allows users to %s their own account',
    async (method, status, body) => {
      const operation = request(server())
        [method](`/api/v1/users/${user.id}`)
        .auth(userToken, { type: 'bearer' });
      if (body) operation.send(body);
      const response = await operation.expect(status);
      const stored = await users().findOne({ _id: user.id });
      expect({ stored: stored?._id, body: responseId(response.body) }).toEqual(
        method === 'delete'
          ? { stored: undefined, body: undefined }
          : { stored: user.id, body: user.id },
      );
    },
  );

  it.each([
    ['get', 200, undefined],
    ['patch', 200, profile],
    ['delete', 204, undefined],
  ] as const)(
    'allows admins to %s another account',
    async (method, status, body) => {
      const operation = request(server())
        [method](`/api/v1/users/${other.id}`)
        .auth(adminToken, { type: 'bearer' });
      if (body) operation.send(body);
      const response = await operation.expect(status);
      const stored = await users().findOne({ _id: other.id });
      expect({ stored: stored?._id, body: responseId(response.body) }).toEqual(
        method === 'delete'
          ? { stored: undefined, body: undefined }
          : { stored: other.id, body: other.id },
      );
    },
  );

  it('allows admins to list accounts', async () => {
    const response = await request(server())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({ meta: { totalItems: 3 } });
  });

  it('allows admins to create ordinary accounts', async () => {
    const response = await request(server())
      .post('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .send(signup)
      .expect(201);
    expect(response.body).toMatchObject({ username: 'new.user', role: 'USER' });
  });

  it('includes the current role in /auth/me', async () => {
    const response = await request(server())
      .get('/api/v1/auth/me')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({ id: admin.id, role: UserRole.ADMIN });
  });

  it('prevents a user from granting themselves admin privileges', async () => {
    await request(server())
      .patch(`/api/v1/users/${user.id}/role`)
      .auth(userToken, { type: 'bearer' })
      .send({ role: UserRole.ADMIN })
      .expect(403);
    expect((await storedUser(user.id)).role).toBe(UserRole.USER);
  });

  it.each([UserRole.USER, UserRole.ADMIN])(
    'allows admins to assign %s',
    async (role) => {
      const response = await request(server())
        .patch(`/api/v1/users/${user.id}/role`)
        .auth(adminToken, { type: 'bearer' })
        .send({ role, expectedVersion: 0, reason: 'Role review' })
        .expect(200);
      expect(response.body).toMatchObject({ id: user.id, role });
    },
  );

  it.each([
    {},
    { role: 'SUPERADMIN' },
    { role: null },
    { role: UserRole.ADMIN, fullName: 'Unexpected' },
  ])('rejects invalid role updates: %j', async (body) => {
    await request(server())
      .patch(`/api/v1/users/${user.id}/role`)
      .auth(adminToken, { type: 'bearer' })
      .send(body)
      .expect(400);
    expect((await storedUser(user.id)).role).toBe(UserRole.USER);
  });

  it('rejects injecting a role through public registration', async () => {
    await request(server())
      .post('/api/v1/auth/register')
      .send({ ...signup, role: UserRole.ADMIN })
      .expect(400);
    expect(await countUsers()).toBe(3);
  });

  it('rejects injecting a role through admin account creation', async () => {
    await request(server())
      .post('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .send({ ...signup, role: UserRole.ADMIN })
      .expect(400);
    expect(await countUsers()).toBe(3);
  });

  it('rejects injecting a role through a profile update', async () => {
    await request(server())
      .patch(`/api/v1/users/${user.id}`)
      .auth(userToken, { type: 'bearer' })
      .send({ ...profile, role: UserRole.ADMIN })
      .expect(400);
    expect((await storedUser(user.id)).role).toBe(UserRole.USER);
  });

  it('ignores admin claims in a token for an ordinary user', async () => {
    const token = await jwt().signAsync({
      sub: user.id,
      username: 'vedora.user',
      role: UserRole.ADMIN,
    });
    await request(server())
      .get('/api/v1/users')
      .auth(token, { type: 'bearer' })
      .expect(403);
  });

  it('stops granting admin access after demotion with the same token', async () => {
    await request(server())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    await users().updateOne(
      { _id: admin.id },
      { $set: { role: UserRole.USER } },
    );
    await request(server())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(403);
  });

  it.each([
    () => '/api/v1/auth/me',
    () => `/api/v1/posts/${randomUUID()}`,
    () => `/api/v1/media/${randomUUID()}`,
  ])('rejects a deleted account with an unexpired token', async (path) => {
    await users().deleteOne({ _id: user.id });
    await request(server())
      .get(path())
      .auth(userToken, { type: 'bearer' })
      .expect(401);
  });

  it('allows an admin to suspend an account with a trimmed audit reason', async () => {
    const response = await request(server())
      .patch(`/api/v1/users/${user.id}/status`)
      .auth(adminToken, { type: 'bearer' })
      .send({
        status: 'SUSPENDED',
        expectedVersion: 0,
        reason: '  Policy review  ',
      })
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'SUSPENDED',
      accountVersion: 1,
    });
    expect(await audits().findOne({})).toMatchObject({
      actorId: admin.id,
      userId: user.id,
      reason: 'Policy review',
      action: 'SUSPEND',
    });
  });

  it('forbids ordinary accounts from suspending themselves', async () => {
    await request(server())
      .patch(`/api/v1/users/${user.id}/status`)
      .auth(userToken, { type: 'bearer' })
      .send({ status: 'SUSPENDED', expectedVersion: 0, reason: 'Review' })
      .expect(403);
    expect((await storedUser(user.id)).status).toBe('ACTIVE');
  });

  it.each([
    {},
    { status: 'DELETED', expectedVersion: 0, reason: 'Review' },
    { status: 'PENDING_EMAIL', expectedVersion: 0, reason: 'Review' },
    { status: 'SUSPENDED', expectedVersion: '0', reason: 'Review' },
    { status: 'SUSPENDED', expectedVersion: -1, reason: 'Review' },
    { status: 'SUSPENDED', expectedVersion: 0.5, reason: 'Review' },
    { status: 'SUSPENDED', expectedVersion: 0, reason: '   ' },
    { status: 'SUSPENDED', expectedVersion: 0, reason: 'x'.repeat(501) },
    {
      status: 'SUSPENDED',
      expectedVersion: 0,
      reason: 'Review',
      userId: randomUUID(),
    },
  ])('rejects invalid status operations: %j', async (body) => {
    await request(server())
      .patch(`/api/v1/users/${user.id}/status`)
      .auth(adminToken, { type: 'bearer' })
      .send(body)
      .expect(400);
    expect((await storedUser(user.id)).status).toBe('ACTIVE');
    expect(await audits().countDocuments()).toBe(0);
  });

  it('returns a conflict code for a stale target version', async () => {
    const response = await request(server())
      .patch(`/api/v1/users/${user.id}/status`)
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'SUSPENDED', expectedVersion: 1, reason: 'Review' })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_VERSION_CONFLICT' });
    expect((await storedUser(user.id)).status).toBe('ACTIVE');
  });

  it.each(['status', 'role', 'delete'])(
    'protects the final ACTIVE admin via the %s endpoint',
    async (endpoint) => {
      const operation =
        endpoint === 'delete'
          ? request(server()).delete(`/api/v1/users/${admin.id}`)
          : request(server())
              .patch(`/api/v1/users/${admin.id}/${endpoint}`)
              .send({
                ...(endpoint === 'role'
                  ? { role: 'USER' }
                  : { status: 'SUSPENDED' }),
                expectedVersion: 0,
                reason: 'Review',
              });
      const response = await operation
        .auth(adminToken, { type: 'bearer' })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
      expect(await storedUser(admin.id)).toMatchObject({
        role: 'ADMIN',
        status: 'ACTIVE',
      });
    },
  );

  it.each([
    () => '/api/v1/auth/me',
    () => '/api/v1/users',
    () => `/api/v1/posts/${randomUUID()}`,
    () => '/api/v1/recipes',
  ])('blocks a suspended account with an unexpired token', async (path) => {
    await users().updateOne(
      { _id: user.id },
      { $set: { status: 'SUSPENDED' } },
    );
    const response = await request(server())
      .get(path())
      .auth(userToken, { type: 'bearer' })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('rejects a pending account token', async () => {
    await users().updateOne(
      { _id: user.id },
      { $set: { status: 'PENDING_EMAIL' } },
    );
    const response = await request(server())
      .get('/api/v1/auth/me')
      .auth(userToken, { type: 'bearer' })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
  });

  it('rejects status injection through profile updates', async () => {
    await request(server())
      .patch(`/api/v1/users/${user.id}`)
      .auth(userToken, { type: 'bearer' })
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('filters admin member search without allowing arbitrary includes', async () => {
    await users().updateOne(
      { _id: other.id },
      { $set: { status: 'SUSPENDED', fullName: 'A Member' } },
    );
    const response = await request(server())
      .get('/api/v1/users?q=Member&status=SUSPENDED')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(
      (response.body as { items: { id: string }[] }).items.map(({ id }) => id),
    ).toEqual([other.id]);
    await request(server())
      .get('/api/v1/users?include=mealPlan')
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
  });
});
