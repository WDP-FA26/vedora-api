import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AccountStatus, PrismaClient, User, UserRole } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { AuthenticatedUser } from '../src/auth/auth.types';
import { EmailVerificationService } from '../src/auth/email-verification.service';
import { PasswordResetService } from '../src/auth/password-reset.service';
import { RefreshTokensService } from '../src/auth/refresh-tokens.service';
import { hashPassword } from '../src/auth/password';
import { hashCode } from '../src/auth/one-time-code';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';

describe('Account administration with PostgreSQL', () => {
  const schema = `vedora_account_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'AccountTests123!';
  let prisma: PrismaClient;
  let users: UsersService;
  let refresh: RefreshTokensService;
  let auth: AuthService;
  let adminA: User;
  let adminB: User;
  let member: User;
  let passwordHash: string;
  const actor = (user: User): AuthenticatedUser => ({
    sub: user.id,
    username: user.username,
    role: user.role,
  });
  const operation = (status: 'ACTIVE' | 'SUSPENDED', expectedVersion = 0) => ({
    status,
    expectedVersion,
    reason: 'Reviewed account',
  });
  const demotion = {
    role: UserRole.USER,
    expectedVersion: 0,
    reason: 'Role review',
  };
  const activeAdminCount = () =>
    prisma.user.count({
      where: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE },
    });

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const db = prisma as PrismaService;
    users = new UsersService(db);
    const config = new ConfigService({
      JWT_ACCESS_TTL: 3600,
      REFRESH_TOKEN_TTL: 2592000,
    });
    refresh = new RefreshTokensService(db, config);
    const mail = {
      sendVerificationCode: vi.fn(),
      sendPasswordResetCode: vi.fn(),
    } as unknown as MailService;
    auth = new AuthService(
      users,
      new JwtService({
        secret: 'account-test-secret-longer-than-32-characters',
        signOptions: { expiresIn: 3600 },
      }),
      refresh,
      new EmailVerificationService(db, mail),
      new PasswordResetService(db, mail),
      config,
    );
    passwordHash = await hashPassword(password);
  });

  beforeEach(async () => {
    await prisma.userAccountAudit.deleteMany();
    await prisma.user.deleteMany();
    const make = (username: string, role: UserRole) =>
      prisma.user.create({
        data: {
          username,
          email: `${username}@example.test`,
          fullName: username,
          role,
          status: AccountStatus.ACTIVE,
          emailVerifiedAt: new Date(),
          passwordHash,
        },
      });
    adminA = await make('admin.a', UserRole.ADMIN);
    adminB = await make('admin.b', UserRole.ADMIN);
    member = await make('member', UserRole.USER);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it('suspends/reactivates with a version and durable actor/reason audit', async () => {
    expect(
      await users.updateStatus(
        member.id,
        operation('SUSPENDED'),
        actor(adminA),
      ),
    ).toMatchObject({ status: 'SUSPENDED', accountVersion: 1 });
    expect(
      await users.updateStatus(
        member.id,
        operation('ACTIVE', 1),
        actor(adminB),
      ),
    ).toMatchObject({ status: 'ACTIVE', accountVersion: 2 });
    const audits = await prisma.userAccountAudit.findMany({
      orderBy: { accountVersion: 'asc' },
    });
    expect(audits).toMatchObject([
      {
        actorId: adminA.id,
        userId: member.id,
        action: 'SUSPEND',
        previousStatus: 'ACTIVE',
        status: 'SUSPENDED',
        reason: 'Reviewed account',
        accountVersion: 1,
      },
      {
        actorId: adminB.id,
        action: 'REACTIVATE',
        previousStatus: 'SUSPENDED',
        status: 'ACTIVE',
        accountVersion: 2,
      },
    ]);
  });

  it('does not add an audit or version for a no-op with a current version', async () => {
    expect(
      await users.updateStatus(member.id, operation('ACTIVE'), actor(adminA)),
    ).toMatchObject({ accountVersion: 0 });
    expect(await prisma.userAccountAudit.count()).toBe(0);
  });

  it('rejects a stale version without changing state or audit', async () => {
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    await expect(
      users.updateStatus(member.id, operation('ACTIVE'), actor(adminB)),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_VERSION_CONFLICT' } });
    expect(await prisma.userAccountAudit.count()).toBe(1);
  });

  it('rolls back the status change when the audit cannot be written', async () => {
    await expect(
      users.updateStatus(
        member.id,
        { ...operation('SUSPENDED'), reason: 'x'.repeat(501) },
        actor(adminA),
      ),
    ).rejects.toThrow();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: member.id } }),
    ).toMatchObject({ status: 'ACTIVE', accountVersion: 0 });
    expect(await prisma.userAccountAudit.count()).toBe(0);
  });

  it.each(['suspend', 'demote', 'delete'] as const)(
    'protects the final ACTIVE admin from %s',
    async (action) => {
      await prisma.user.delete({ where: { id: adminB.id } });
      const attempt =
        action === 'suspend'
          ? users.updateStatus(adminA.id, operation('SUSPENDED'), actor(adminA))
          : action === 'demote'
            ? users.updateRole(adminA.id, demotion, actor(adminA))
            : users.remove(adminA.id, actor(adminA));
      await expect(attempt).rejects.toMatchObject({
        response: { code: 'LAST_ACTIVE_ADMIN' },
      });
      expect(await activeAdminCount()).toBe(1);
      expect(await prisma.userAccountAudit.count()).toBe(0);
    },
  );

  it('allows self-demotion while another ACTIVE admin remains', async () => {
    expect(
      await users.updateRole(adminA.id, demotion, actor(adminA)),
    ).toMatchObject({ role: 'USER', accountVersion: 1 });
    expect(await activeAdminCount()).toBe(1);
  });

  it('does not count suspended admins as a replacement for the last admin', async () => {
    await users.updateStatus(adminB.id, operation('SUSPENDED'), actor(adminA));
    await expect(
      users.updateRole(adminA.id, demotion, actor(adminA)),
    ).rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMIN' } });
  });

  it.each(['suspend', 'demote', 'delete'] as const)(
    'serializes concurrent self-%s on two different admins',
    async (action) => {
      const execute = (admin: User) =>
        action === 'suspend'
          ? users.updateStatus(admin.id, operation('SUSPENDED'), actor(admin))
          : action === 'demote'
            ? users.updateRole(admin.id, demotion, actor(admin))
            : users.remove(admin.id, actor(admin));
      const results = await Promise.allSettled([
        execute(adminA),
        execute(adminB),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await activeAdminCount()).toBe(1);
      expect(await prisma.userAccountAudit.count()).toBe(1);
    },
  );

  it('rechecks a stale actor role inside the transaction', async () => {
    await users.updateRole(adminB.id, demotion, actor(adminA));
    await expect(
      users.updateStatus(member.id, operation('SUSPENDED'), actor(adminB)),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: member.id } }),
    ).toMatchObject({ status: 'ACTIVE' });
  });

  it('prevents ordinary accounts from changing status through the service', async () => {
    await expect(
      users.updateStatus(member.id, operation('SUSPENDED'), actor(member)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows only one of two different changes using the same target version', async () => {
    const results = await Promise.allSettled([
      users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA)),
      users.updateRole(
        member.id,
        { ...demotion, role: UserRole.ADMIN },
        actor(adminB),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { response: { code: 'ACCOUNT_VERSION_CONFLICT' } },
    });
  });

  it('does not activate pending email accounts with an admin status command', async () => {
    const pending = await prisma.user.create({
      data: {
        username: 'pending',
        email: 'pending@example.test',
        fullName: 'Pending',
      },
    });
    expect(pending.status).toBe('PENDING_EMAIL');
    await expect(
      users.updateStatus(pending.id, operation('ACTIVE'), actor(adminA)),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_ACCOUNT_TRANSITION' },
    });
  });

  it('rejects suspended password login and Google sign-in/linking without issuing tokens', async () => {
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    await expect(
      auth.login({ username: member.username, password }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
    await expect(
      auth.googleLogin({
        googleId: 'google-member',
        email: member.email,
        fullName: member.fullName,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
    await prisma.user.update({
      where: { id: member.id },
      data: { googleId: 'google-member' },
    });
    await expect(
      auth.googleLogin({
        googleId: 'google-member',
        email: member.email,
        fullName: member.fullName,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
    expect(await prisma.refreshToken.count()).toBe(0);
  });

  it('blocks refresh while suspended and allows it again after reactivation without blacklisting', async () => {
    const issued = await refresh.issue(member.id);
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    await expect(refresh.rotate(issued.token)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(await prisma.refreshToken.count()).toBe(1);
    await users.updateStatus(member.id, operation('ACTIVE', 1), actor(adminA));
    expect(await refresh.rotate(issued.token)).toMatchObject({
      userId: member.id,
    });
  });

  it('orders new refresh-token issuance after a committed suspension', async () => {
    let issuing: Promise<unknown> = Promise.resolve();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${member.id}::uuid FOR UPDATE`;
      issuing = refresh.issue(member.id).catch((error: unknown) => error);
      await tx.user.update({
        where: { id: member.id },
        data: { status: AccountStatus.SUSPENDED },
      });
    });
    expect(await issuing).toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(await prisma.refreshToken.count()).toBe(0);
  });

  it('filters member search by status and case-insensitive name/email without private relations', async () => {
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    const result = await users.findAll({
      page: 1,
      limit: 20,
      q: 'MEMBER@EXAMPLE',
      status: AccountStatus.SUSPENDED,
    });
    expect(result.meta.totalItems).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: member.id,
      status: 'SUSPENDED',
      accountVersion: 1,
    });
    expect(Object.keys(result.items[0]).sort()).toEqual(
      [
        'id',
        'username',
        'fullName',
        'email',
        'role',
        'status',
        'accountVersion',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('retains the deletion audit after the account is physically removed', async () => {
    await users.remove(member.id, actor(member));
    expect(
      await prisma.user.findUnique({ where: { id: member.id } }),
    ).toBeNull();
    expect(await prisma.userAccountAudit.findFirst()).toMatchObject({
      actorId: member.id,
      userId: member.id,
      action: 'DELETE',
      status: 'DELETED',
    });
  });

  it('verifies a pending email into ACTIVE before issuing a token pair', async () => {
    await prisma.user.update({
      where: { id: member.id },
      data: { status: AccountStatus.PENDING_EMAIL, emailVerifiedAt: null },
    });
    const now = new Date();
    await prisma.emailVerificationCode.create({
      data: {
        userId: member.id,
        codeHash: hashCode(member.id, '123456'),
        expiresAt: new Date(now.getTime() + 600_000),
        sentAt: now,
        firstSentAt: now,
      },
    });
    expect(
      await auth.verifyEmail({ email: member.email, code: '123456' }),
    ).toMatchObject({ user: { status: 'ACTIVE' }, tokenType: 'Bearer' });
  });

  it('password reset never reactivates a suspended account', async () => {
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    const now = new Date();
    const codeHash = createHash('sha256')
      .update(`password-reset:${member.id}:123456`)
      .digest('hex');
    await prisma.passwordResetCode.create({
      data: {
        userId: member.id,
        codeHash,
        expiresAt: new Date(now.getTime() + 600_000),
        sentAt: now,
        firstSentAt: now,
      },
    });
    await auth.resetPassword({
      email: member.email,
      code: '123456',
      password: 'NewAccountPassword123!',
    });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: member.id } }),
    ).toMatchObject({ status: 'SUSPENDED', accountVersion: 1 });
  });
});
