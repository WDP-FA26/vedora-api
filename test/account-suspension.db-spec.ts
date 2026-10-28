import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthenticatedUser } from '../src/auth/auth.types.js';
import { EmailVerificationService } from '../src/auth/email-verification.service.js';
import { PasswordResetService } from '../src/auth/password-reset.service.js';
import { RefreshTokensService } from '../src/auth/refresh-tokens.service.js';
import { hashPassword } from '../src/auth/password.js';
import { hashCode } from '../src/auth/one-time-code.js';
import { MailService } from '../src/mail/mail.service.js';
import { MongoModule } from '../src/mongo/mongo.module.js';
import { MongoService } from '../src/mongo/mongo.service.js';
import { lockDocument } from '../src/mongo/document-lock.js';
import {
  AccountStatus,
  OneTimeCode,
  OneTimeCodePurpose,
  User,
  UserAccountAudit,
  UserRole,
} from '../src/mongo/models.js';
import { UpdateUserStatusDto } from '../src/users/dto/update-user-status.dto.js';
import { AccountsService } from '../src/users/accounts.service.js';
import { UsersService } from '../src/users/users.service.js';
import { createUser, deleteWithCascade } from './fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db.js';

describe('Account administration with MongoDB', () => {
  const password = 'AccountTests123!';
  let app: INestApplication;
  let mongo: MongoService;
  let users: UsersService;
  let refresh: RefreshTokensService;
  let auth: AuthService;
  let adminA: User;
  let adminB: User;
  let member: User;
  let passwordHash: string;
  const mail = {
    sendVerificationCode: vi.fn(),
    sendPasswordResetCode: vi.fn(),
  };
  const actor = (user: User): AuthenticatedUser => ({
    sub: user.id,
    username: user.username,
    role: user.role,
  });
  const operation = (
    status: 'ACTIVE' | 'SUSPENDED',
    expectedVersion = 0,
  ): UpdateUserStatusDto => ({
    status: status as UpdateUserStatusDto['status'],
    expectedVersion,
    reason: 'Reviewed account',
  });
  const demotion = {
    role: UserRole.USER,
    expectedVersion: 0,
    reason: 'Role review',
  };
  const userModel = () => mongo.connection.model<User>(User.name);
  const auditModel = () =>
    mongo.connection.model<UserAccountAudit>(UserAccountAudit.name);
  const codeModel = () => mongo.connection.model<OneTimeCode>(OneTimeCode.name);
  const count = (collection: string) =>
    mongo.connection.collections[collection].countDocuments();
  const activeAdminCount = () =>
    userModel().countDocuments({
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
    });
  const findUser = (id: string) => userModel().findOne({ _id: id }).exec();
  const audits = () => auditModel().find().sort({ accountVersion: 1 }).exec();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('account'))],
      providers: [
        UsersService,
        AccountsService,
        RefreshTokensService,
        EmailVerificationService,
        PasswordResetService,
        AuthService,
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_ACCESS_TTL: 3600,
            REFRESH_TOKEN_TTL: 2592000,
          }),
        },
        {
          provide: JwtService,
          useValue: new JwtService({
            secret: 'account-test-secret-longer-than-32-characters',
            signOptions: { expiresIn: 3600 },
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    users = app.get(UsersService);
    refresh = app.get(RefreshTokensService);
    auth = app.get(AuthService);
    passwordHash = await hashPassword(password);
  });

  beforeEach(async () => {
    await auditModel().deleteMany({});
    await codeModel().deleteMany({});
    await mongo.connection.collections.refresh_tokens.deleteMany({});
    await mongo.connection.collections.email_verification_guesses.deleteMany(
      {},
    );
    await mongo.withTransaction((session) =>
      userModel().deleteMany({}, { session }).exec(),
    );
    const make = (username: string, role: UserRole) =>
      createUser(mongo, {
        username,
        email: `${username}@example.test`,
        fullName: username,
        role,
        passwordHash,
      });
    adminA = await make('admin.a', UserRole.ADMIN);
    adminB = await make('admin.b', UserRole.ADMIN);
    member = await make('member', UserRole.USER);
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
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
    expect(await audits()).toMatchObject([
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
    expect(await count('user_account_audits')).toBe(0);
  });

  it('rejects a stale version without changing state or audit', async () => {
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    await expect(
      users.updateStatus(member.id, operation('ACTIVE'), actor(adminB)),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_VERSION_CONFLICT' } });
    expect(await count('user_account_audits')).toBe(1);
  });

  it('rolls back the status change when the audit cannot be written', async () => {
    // Make the audit insert fail: add a rule to the collection's validator
    // for the duration of the test.
    await mongo.connection.db!.command({
      collMod: 'user_account_audits',
      validator: { $expr: { $lte: [{ $strLenCP: '$reason' }, 500] } },
    });
    try {
      await expect(
        users.updateStatus(
          member.id,
          { ...operation('SUSPENDED'), reason: 'x'.repeat(501) },
          actor(adminA),
        ),
      ).rejects.toThrow();
    } finally {
      await mongo.connection.db!.command({
        collMod: 'user_account_audits',
        validator: {},
      });
    }
    expect(await findUser(member.id)).toMatchObject({
      status: 'ACTIVE',
      accountVersion: 0,
    });
    expect(await count('user_account_audits')).toBe(0);
  });

  it.each(['suspend', 'demote', 'delete'] as const)(
    'protects the final ACTIVE admin from %s',
    async (action) => {
      await deleteWithCascade(mongo, 'users', adminB.id);
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
      expect(await count('user_account_audits')).toBe(0);
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
      expect(await count('user_account_audits')).toBe(1);
    },
  );

  it('rechecks a stale actor role inside the transaction', async () => {
    await users.updateRole(adminB.id, demotion, actor(adminA));
    await expect(
      users.updateStatus(member.id, operation('SUSPENDED'), actor(adminB)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await findUser(member.id)).toMatchObject({ status: 'ACTIVE' });
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
    const pending = await createUser(mongo, {
      username: 'pending',
      email: 'pending@example.test',
      fullName: 'Pending',
      status: AccountStatus.PENDING_EMAIL,
      emailVerifiedAt: null,
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
    await userModel()
      .updateOne({ _id: member.id }, { $set: { googleId: 'google-member' } })
      .exec();
    await expect(
      auth.googleLogin({
        googleId: 'google-member',
        email: member.email,
        fullName: member.fullName,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
    expect(await count('refresh_tokens')).toBe(0);
  });

  it('blocks refresh while suspended and allows it again after reactivation without blacklisting', async () => {
    const issued = await refresh.issue(member.id);
    await users.updateStatus(member.id, operation('SUSPENDED'), actor(adminA));
    await expect(refresh.rotate(issued.token)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(await count('refresh_tokens')).toBe(1);
    await users.updateStatus(member.id, operation('ACTIVE', 1), actor(adminA));
    expect(await refresh.rotate(issued.token)).toMatchObject({
      userId: member.id,
    });
  });

  it('orders new refresh-token issuance after a committed suspension', async () => {
    let issuing: Promise<unknown> = Promise.resolve();
    await mongo.withTransaction(async (session) => {
      await lockDocument(mongo, session, 'user', member.id);
      issuing = refresh.issue(member.id).catch((error: unknown) => error);
      await userModel()
        .updateOne(
          { _id: member.id },
          { $set: { status: AccountStatus.SUSPENDED } },
          { session },
        )
        .exec();
    });
    expect(await issuing).toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(await count('refresh_tokens')).toBe(0);
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
    expect(await findUser(member.id)).toBeNull();
    expect(await auditModel().findOne({}).exec()).toMatchObject({
      actorId: member.id,
      userId: member.id,
      action: 'DELETE',
      status: 'DELETED',
    });
  });

  it('verifies a pending email into ACTIVE before issuing a token pair', async () => {
    await userModel()
      .updateOne(
        { _id: member.id },
        {
          $set: { status: AccountStatus.PENDING_EMAIL, emailVerifiedAt: null },
        },
      )
      .exec();
    const now = new Date();
    await codeModel().create({
      _id: randomUUID(),
      attempts: 0,
      resendCount: 0,
      userId: member.id,
      purpose: OneTimeCodePurpose.EMAIL_VERIFICATION,
      codeHash: hashCode(member.id, '123456'),
      expiresAt: new Date(now.getTime() + 600_000),
      sentAt: now,
      firstSentAt: now,
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
    await codeModel().create({
      _id: randomUUID(),
      attempts: 0,
      resendCount: 0,
      userId: member.id,
      purpose: OneTimeCodePurpose.PASSWORD_RESET,
      codeHash,
      expiresAt: new Date(now.getTime() + 600_000),
      sentAt: now,
      firstSentAt: now,
    });
    await auth.resetPassword({
      email: member.email,
      code: '123456',
      password: 'NewAccountPassword123!',
    });
    expect(await findUser(member.id)).toMatchObject({
      status: 'SUSPENDED',
      accountVersion: 1,
    });
  });
});
