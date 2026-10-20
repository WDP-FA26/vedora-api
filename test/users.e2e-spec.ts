import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { User, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const ADMIN_ID = 'c9ee4d58-ce10-4572-bd39-952a310ace87';
const OTHER_ID = 'a6ff1292-ed03-4c34-a9cf-b4c7a27cbd82';

function account(id: string, role: UserRole = UserRole.USER): User {
  return {
    id,
    username: role === UserRole.ADMIN ? 'vedora.admin' : 'vedora.user',
    fullName: 'Vedora User',
    email: `${id}@vedora.vn`,
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    isProfessional: false,
    role,
    status: 'ACTIVE',
    accountVersion: 0,
    passwordHash: null,
    googleId: null,
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Account permissions (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let jwt: JwtService;
  let userToken: string;
  let adminToken: string;
  const profile = { fullName: 'Updated Name' };
  const signup = {
    username: 'new.user',
    fullName: 'New User',
    email: 'new@vedora.vn',
    password: 'StrongPassword123!',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
    // Tokens deliberately have no role claim, including tokens issued before
    // this migration. The database decides their current permissions.
    userToken = await jwt.signAsync({ sub: USER_ID, username: 'vedora.user' });
    adminToken = await jwt.signAsync({
      sub: ADMIN_ID,
      username: 'vedora.admin',
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockImplementation(
      ({ where }) =>
        Promise.resolve(
          account(
            where.id ?? USER_ID,
            where.id === ADMIN_ID ? UserRole.ADMIN : UserRole.USER,
          ),
        ) as ReturnType<PrismaService['user']['findUnique']>,
    );
    prisma.user.update.mockResolvedValue(account(USER_ID));
    prisma.user.delete.mockResolvedValue(account(USER_ID));
    prisma.user.create.mockResolvedValue(account(OTHER_ID));
    prisma.user.findMany.mockResolvedValue([account(USER_ID)]);
    prisma.user.count.mockResolvedValue(2);
    prisma.$transaction.mockImplementation((operation: unknown) =>
      typeof operation === 'function'
        ? (operation as (tx: PrismaService) => Promise<never>)(prisma)
        : Promise.resolve([[account(USER_ID)], 1]),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires authentication to list accounts', async () => {
    await request(app.getHttpServer()).get('/api/v1/users').expect(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid JWTs before accessing the database', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth('invalid-token', { type: 'bearer' })
      .expect(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects malformed account IDs in signed JWTs', async () => {
    const token = await jwt.signAsync({
      sub: 'invalid-id',
      username: 'vedora.user',
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('prevents ordinary users from listing accounts', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth(userToken, { type: 'bearer' })
      .expect(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('prevents ordinary users from creating accounts through admin CRUD', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .auth(userToken, { type: 'bearer' })
      .send(signup)
      .expect(403);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['get', undefined],
    ['patch', profile],
    ['delete', undefined],
  ] as const)(
    'prevents users from calling %s on someone else',
    async (method, body) => {
      const operation = request(app.getHttpServer())
        [method](`/api/v1/users/${OTHER_ID}`)
        .auth(userToken, { type: 'bearer' });
      if (body) operation.send(body);
      await operation.expect(403);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
      // Only the authenticated user's lookup occurs, never the target's.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['get', 200, undefined],
    ['patch', 200, profile],
    ['delete', 204, undefined],
  ] as const)(
    'allows users to %s their own account',
    async (method, status, body) => {
      const operation = request(app.getHttpServer())
        [method](`/api/v1/users/${USER_ID}`)
        .auth(userToken, { type: 'bearer' });
      if (body) operation.send(body);
      const response = await operation.expect(status);
      const affected: unknown =
        method === 'delete'
          ? prisma.user.delete.mock.calls[0]?.[0].where
          : response.body;
      expect(affected).toMatchObject({ id: USER_ID });
    },
  );

  it.each([
    ['get', 200, undefined],
    ['patch', 200, profile],
    ['delete', 204, undefined],
  ] as const)(
    'allows admins to %s another account',
    async (method, status, body) => {
      prisma.user.update.mockResolvedValue(account(OTHER_ID));
      const operation = request(app.getHttpServer())
        [method](`/api/v1/users/${OTHER_ID}`)
        .auth(adminToken, { type: 'bearer' });
      if (body) operation.send(body);
      const response = await operation.expect(status);
      const affected: unknown =
        method === 'delete'
          ? prisma.user.delete.mock.calls[0]?.[0].where
          : response.body;
      expect(affected).toMatchObject({ id: OTHER_ID });
    },
  );

  it('allows admins to list accounts', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({
      items: [{ id: USER_ID }],
      meta: { totalItems: 1 },
    });
  });

  it('allows admins to create ordinary accounts', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .send(signup)
      .expect(201);
    const [created] = prisma.user.create.mock.calls[0];
    expect(created.data).not.toHaveProperty('role');
  });

  it('includes the current role in /auth/me', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(response.body).toMatchObject({ id: ADMIN_ID, role: UserRole.ADMIN });
  });

  it('prevents a user from granting themselves admin privileges', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/role`)
      .auth(userToken, { type: 'bearer' })
      .send({ role: UserRole.ADMIN })
      .expect(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([UserRole.USER, UserRole.ADMIN])(
    'allows admins to assign %s',
    async (role) => {
      prisma.user.update.mockResolvedValue(account(USER_ID, role));
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${USER_ID}/role`)
        .auth(adminToken, { type: 'bearer' })
        .send({ role, expectedVersion: 0, reason: 'Role review' })
        .expect(200);
      expect(response.body).toMatchObject({ id: USER_ID, role });
    },
  );

  it.each([
    {},
    { role: 'SUPERADMIN' },
    { role: null },
    { role: UserRole.ADMIN, fullName: 'Unexpected' },
  ])('rejects invalid role updates: %j', async (body) => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/role`)
      .auth(adminToken, { type: 'bearer' })
      .send(body)
      .expect(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects injecting a role through public registration', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...signup, role: UserRole.ADMIN })
      .expect(400);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects injecting a role through admin account creation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .send({ ...signup, role: UserRole.ADMIN })
      .expect(400);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects injecting a role through a profile update', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}`)
      .auth(userToken, { type: 'bearer' })
      .send({ ...profile, role: UserRole.ADMIN })
      .expect(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('ignores admin claims in a token for an ordinary user', async () => {
    const token = await jwt.signAsync({
      sub: USER_ID,
      username: 'vedora.user',
      role: UserRole.ADMIN,
    });
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth(token, { type: 'bearer' })
      .expect(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('stops granting admin access after demotion with the same token', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    prisma.user.findUnique.mockResolvedValue(account(ADMIN_ID, UserRole.USER));
    prisma.user.findMany.mockClear();
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .auth(adminToken, { type: 'bearer' })
      .expect(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it.each([
    '/api/v1/auth/me',
    `/api/v1/posts/${OTHER_ID}`,
    `/api/v1/media/${OTHER_ID}`,
  ])(
    'rejects a deleted account on %s even with an unexpired token',
    async (path) => {
      prisma.user.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(path)
        .auth(userToken, { type: 'bearer' })
        .expect(401);
    },
  );

  it('allows an admin to suspend an account with a trimmed audit reason', async () => {
    prisma.user.update.mockResolvedValue({
      ...account(USER_ID),
      status: 'SUSPENDED',
      accountVersion: 1,
    });
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/status`)
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
    expect(prisma.userAccountAudit.create.mock.calls[0][0].data).toMatchObject({
      actorId: ADMIN_ID,
      userId: USER_ID,
      reason: 'Policy review',
      action: 'SUSPEND',
    });
  });

  it('forbids ordinary accounts from suspending themselves', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/status`)
      .auth(userToken, { type: 'bearer' })
      .send({ status: 'SUSPENDED', expectedVersion: 0, reason: 'Review' })
      .expect(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
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
      userId: OTHER_ID,
    },
  ])('rejects invalid status operations: %j', async (body) => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/status`)
      .auth(adminToken, { type: 'bearer' })
      .send(body)
      .expect(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userAccountAudit.create).not.toHaveBeenCalled();
  });

  it('returns a conflict code for a stale target version', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}/status`)
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'SUSPENDED', expectedVersion: 1, reason: 'Review' })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_VERSION_CONFLICT' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['status', 'role', 'delete'])(
    'protects the final ACTIVE admin via the %s endpoint',
    async (endpoint) => {
      prisma.user.count.mockResolvedValue(1);
      const operation =
        endpoint === 'delete'
          ? request(app.getHttpServer()).delete(`/api/v1/users/${ADMIN_ID}`)
          : request(app.getHttpServer())
              .patch(`/api/v1/users/${ADMIN_ID}/${endpoint}`)
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
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/api/v1/auth/me',
    '/api/v1/users',
    `/api/v1/posts/${OTHER_ID}`,
    '/api/v1/recipes',
  ])(
    'blocks a suspended account on %s with an unexpired token',
    async (path) => {
      prisma.user.findUnique.mockResolvedValue({
        ...account(USER_ID),
        status: 'SUSPENDED',
      });
      const response = await request(app.getHttpServer())
        .get(path)
        .auth(userToken, { type: 'bearer' })
        .expect(401);
      expect(response.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    },
  );

  it('rejects a pending account token', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...account(USER_ID),
      status: 'PENDING_EMAIL',
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(userToken, { type: 'bearer' })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
  });

  it('rejects status injection through profile updates', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_ID}`)
      .auth(userToken, { type: 'bearer' })
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('filters admin member search without allowing arbitrary includes', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users?q=Member&status=SUSPENDED')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(prisma.user.findMany.mock.calls[0][0]?.where).toMatchObject({
      status: 'SUSPENDED',
    });
    await request(app.getHttpServer())
      .get('/api/v1/users?include=mealPlan')
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
  });
});
