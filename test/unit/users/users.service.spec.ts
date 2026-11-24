import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '@src/auth-core/auth.types.js';
import { AccessDeniedException } from '@src/common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import { UnauthenticatedException } from '@src/common/exceptions/unauthenticated.exception.js';
import {
  AccountStatus,
  User,
  UserAccountAction,
  UserAccountAudit,
  UserRole,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { AccountsService } from '@src/users/accounts.service.js';
import { UsersService } from '@src/users/users.service.js';
import { createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

describe('UsersService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: UsersService;

  const users = () => db.connection.model<User>(User.name);
  const audits = () =>
    db.connection.model<UserAccountAudit>(UserAccountAudit.name);

  const asActor = (user: User, roleOverride?: UserRole): AuthenticatedUser => ({
    sub: user.id,
    username: user.username,
    role: roleOverride ?? user.role,
    actorId: null,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('usersservice'))],
      providers: [AccountsService, UsersService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(UsersService);
  });

  beforeEach(async () => {
    await users().deleteMany({});
    await audits().deleteMany({});
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('findAll', () => {
    it('paginates newest first and filters by status, escaped q, or both', async () => {
      const oldest = await createUser(db, {
        username: 'alpha.chef',
        fullName: 'Alpha Chef',
        email: 'alpha@vedora.vn',
        status: AccountStatus.ACTIVE,
      });
      const middle = await createUser(db, {
        username: 'beta.cook',
        fullName: 'Beta+Special',
        email: 'beta@vedora.vn',
        status: AccountStatus.SUSPENDED,
      });
      const newest = await createUser(db, {
        username: 'gamma.baker',
        fullName: 'Gamma Baker',
        email: 'beta+tag@vedora.vn',
        status: AccountStatus.ACTIVE,
      });

      await users().collection.updateOne(
        { _id: oldest.id },
        { $set: { createdAt: new Date('2026-10-01T00:00:00Z') } },
      );
      await users().collection.updateOne(
        { _id: middle.id },
        { $set: { createdAt: new Date('2026-10-02T00:00:00Z') } },
      );
      await users().collection.updateOne(
        { _id: newest.id },
        { $set: { createdAt: new Date('2026-10-03T00:00:00Z') } },
      );

      const page1 = await service.findAll({ page: 1, limit: 2 });
      expect(page1.items.map((u) => u.id)).toEqual([newest.id, middle.id]);
      expect(page1.meta).toEqual({
        page: 1,
        limit: 2,
        totalItems: 3,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      const suspendedOnly = await service.findAll({
        page: 1,
        limit: 20,
        status: AccountStatus.SUSPENDED,
      });
      expect(suspendedOnly.items.map((u) => u.id)).toEqual([middle.id]);

      const regexEscaped = await service.findAll({
        page: 1,
        limit: 20,
        q: 'Beta+',
      });
      expect(regexEscaped.items.map((u) => u.id)).toEqual([
        newest.id,
        middle.id,
      ]);

      const combined = await service.findAll({
        page: 1,
        limit: 20,
        status: AccountStatus.ACTIVE,
        q: 'beta+',
      });
      expect(combined.items.map((u) => u.id)).toEqual([newest.id]);
    });
  });

  describe('findOne', () => {
    it('allows own account and admin lookup, and forbids cross-user lookup', async () => {
      const member = await createUser(db, { passwordHash: 'secret-hash' });
      const other = await createUser(db);
      const admin = await createUser(db, { role: UserRole.ADMIN });

      const selfView = await service.findOne(member.id, asActor(member));
      expect(selfView.id).toBe(member.id);
      expect(selfView).not.toHaveProperty('passwordHash');

      const adminView = await service.findOne(member.id, asActor(admin));
      expect(adminView.id).toBe(member.id);

      await expect(
        service.findOne(other.id, asActor(member)),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      await expect(
        service.findOne(randomUUID(), asActor(admin)),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('update', () => {
    it('updates username and fullName individually for self or admin without changing email', async () => {
      const member = await createUser(db, {
        username: 'orig.user',
        fullName: 'Orig Name',
        email: 'orig@vedora.vn',
      });
      const admin = await createUser(db, { role: UserRole.ADMIN });

      const u1 = await service.update(
        member.id,
        { username: 'new.user' },
        asActor(member),
      );
      expect(u1.username).toBe('new.user');
      expect(u1.fullName).toBe('Orig Name');
      expect(u1.email).toBe('orig@vedora.vn');

      const u2 = await service.update(
        member.id,
        { fullName: 'New Name' },
        asActor(admin),
      );
      expect(u2.fullName).toBe('New Name');
      expect(u2.email).toBe('orig@vedora.vn');
    });

    it('rejects unauthorized updates, missing users, and unique violations', async () => {
      const member = await createUser(db, { username: 'member.one' });
      const other = await createUser(db, { username: 'member.two' });
      const admin = await createUser(db, { role: UserRole.ADMIN });

      await expect(
        service.update(other.id, { fullName: 'Nope' }, asActor(member)),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      await expect(
        service.update(randomUUID(), { fullName: 'Nope' }, asActor(admin)),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await expect(
        service.update(member.id, { username: 'member.two' }, asActor(member)),
      ).rejects.toBeInstanceOf(StateConflictException);
    });
  });

  describe('remove', () => {
    it('allows self-deletion and admin-deletion of a user with an audit record', async () => {
      const selfUser = await createUser(db);
      const targetUser = await createUser(db);
      const admin = await createUser(db, { role: UserRole.ADMIN });

      await service.remove(selfUser.id, asActor(selfUser));
      expect(await users().findById(selfUser.id).exec()).toBeNull();

      await service.remove(targetUser.id, asActor(admin));
      expect(await users().findById(targetUser.id).exec()).toBeNull();

      const targetAudit = await audits()
        .findOne({ userId: targetUser.id })
        .exec();
      expect(targetAudit).toMatchObject({
        actorId: admin.id,
        userId: targetUser.id,
        action: UserAccountAction.DELETE,
        reason: 'Account deletion requested',
        previousStatus: AccountStatus.ACTIVE,
        status: AccountStatus.DELETED,
        previousRole: UserRole.USER,
        role: UserRole.USER,
        accountVersion: 1,
      });
    });

    it('forbids non-admins and stale-admin JWTs from deleting another account', async () => {
      const member = await createUser(db);
      const demotedInDb = await createUser(db, { role: UserRole.USER });
      const target = await createUser(db);

      await expect(
        service.remove(target.id, asActor(member)),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      await expect(
        service.remove(target.id, asActor(demotedInDb, UserRole.ADMIN)),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only admins can manage another account',
      });
      expect(await users().findById(target.id).exec()).not.toBeNull();
    });

    it('rejects missing/suspended actor and missing/DELETED target inside the gate', async () => {
      const admin = await createUser(db, { role: UserRole.ADMIN });
      const suspendedAdmin = await createUser(db, {
        role: UserRole.ADMIN,
        status: AccountStatus.SUSPENDED,
      });
      const deletedTarget = await createUser(db, {
        status: AccountStatus.DELETED,
      });

      await expect(
        service.remove(deletedTarget.id, asActor(admin)),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await expect(
        service.remove(randomUUID(), asActor(admin)),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await expect(
        service.remove(deletedTarget.id, asActor(suspendedAdmin)),
      ).rejects.toBeInstanceOf(UnauthenticatedException);

      await users().deleteOne({ _id: admin.id });
      await expect(
        service.remove(randomUUID(), asActor(admin)),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Account no longer exists',
      });
    });

    it('protects the last ACTIVE admin while allowing deletion when another ACTIVE admin exists', async () => {
      const activeAdmin1 = await createUser(db, { role: UserRole.ADMIN });
      const suspendedAdmin = await createUser(db, {
        role: UserRole.ADMIN,
        status: AccountStatus.SUSPENDED,
      });

      await expect(
        service.remove(activeAdmin1.id, asActor(activeAdmin1)),
      ).rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
      expect(await users().findById(activeAdmin1.id).exec()).not.toBeNull();
      expect(await audits().countDocuments()).toBe(0);

      // A SUSPENDED admin is not protected by last-active-admin.
      await service.remove(suspendedAdmin.id, asActor(activeAdmin1));
      expect(await users().findById(suspendedAdmin.id).exec()).toBeNull();

      const activeAdmin2 = await createUser(db, { role: UserRole.ADMIN });
      await service.remove(activeAdmin1.id, asActor(activeAdmin2));
      expect(await users().findById(activeAdmin1.id).exec()).toBeNull();
    });
  });

  describe('updateRole', () => {
    it('enforces admin role, version match, no-op semantics, and audit logging', async () => {
      const admin = await createUser(db, { role: UserRole.ADMIN });
      const member = await createUser(db, { role: UserRole.USER });

      await expect(
        service.updateRole(
          member.id,
          { role: UserRole.ADMIN, expectedVersion: 0, reason: 'No perm' },
          asActor(member),
        ),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      // No-op when role is unchanged and expectedVersion matches
      const noop = await service.updateRole(
        member.id,
        { role: UserRole.USER, expectedVersion: 0, reason: 'Already user' },
        asActor(admin),
      );
      expect(noop.accountVersion).toBe(0);
      expect(await audits().countDocuments()).toBe(0);

      // Promote USER -> ADMIN
      const promoted = await service.updateRole(
        member.id,
        { role: UserRole.ADMIN, expectedVersion: 0, reason: 'Promote' },
        asActor(admin),
      );
      expect(promoted.role).toBe(UserRole.ADMIN);
      expect(promoted.accountVersion).toBe(1);

      // Stale version fails
      await expect(
        service.updateRole(
          member.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Stale' },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_VERSION_CONFLICT' });

      // Self-demotion succeeds while another ACTIVE admin exists
      const demotedSelf = await service.updateRole(
        member.id,
        { role: UserRole.USER, expectedVersion: 1, reason: 'Step down' },
        asActor(member, UserRole.ADMIN),
      );
      expect(demotedSelf.role).toBe(UserRole.USER);
      expect(demotedSelf.accountVersion).toBe(2);

      // Cannot demote the last ACTIVE admin
      await expect(
        service.updateRole(
          admin.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Last admin' },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
    });

    it('serializes concurrent demotions so an ACTIVE admin always remains', async () => {
      const adminA = await createUser(db, { role: UserRole.ADMIN });
      const adminB = await createUser(db, { role: UserRole.ADMIN });

      const results = await Promise.allSettled([
        service.updateRole(
          adminB.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Demote B' },
          asActor(adminA),
        ),
        service.updateRole(
          adminA.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Demote A' },
          asActor(adminB),
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const remainingAdmins = await users().countDocuments({
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
      });
      expect(remainingAdmins).toBe(1);
    });

    it('rejects concurrent self-demotion and peer-demotion of the last two admins with LAST_ACTIVE_ADMIN', async () => {
      const adminA = await createUser(db, { role: UserRole.ADMIN });
      const adminB = await createUser(db, { role: UserRole.ADMIN });

      const results = await Promise.allSettled([
        service.updateRole(
          adminB.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Demote B' },
          asActor(adminA),
        ),
        service.updateRole(
          adminA.id,
          { role: UserRole.USER, expectedVersion: 0, reason: 'Self demote A' },
          asActor(adminA),
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        code: expect.stringMatching(
          /^(LAST_ACTIVE_ADMIN|FORBIDDEN)$/,
        ) as string,
      });
      expect(
        await users().countDocuments({
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
        }),
      ).toBe(1);
    });
  });

  describe('updateStatus', () => {
    it('suspends and reactivates verified accounts with version checks and audit logs', async () => {
      const admin = await createUser(db, { role: UserRole.ADMIN });
      const member = await createUser(db, { status: AccountStatus.ACTIVE });

      await expect(
        service.updateStatus(
          member.id,
          {
            status: AccountStatus.SUSPENDED,
            expectedVersion: 0,
            reason: 'No perm',
          },
          asActor(member),
        ),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      // No-op when status matches
      const noop = await service.updateStatus(
        member.id,
        {
          status: AccountStatus.ACTIVE,
          expectedVersion: 0,
          reason: 'Already active',
        },
        asActor(admin),
      );
      expect(noop.accountVersion).toBe(0);

      // Suspend ACTIVE -> SUSPENDED
      const suspended = await service.updateStatus(
        member.id,
        {
          status: AccountStatus.SUSPENDED,
          expectedVersion: 0,
          reason: 'Spamming',
        },
        asActor(admin),
      );
      expect(suspended.status).toBe(AccountStatus.SUSPENDED);
      expect(suspended.accountVersion).toBe(1);

      // Stale version fails
      await expect(
        service.updateStatus(
          member.id,
          {
            status: AccountStatus.ACTIVE,
            expectedVersion: 0,
            reason: 'Stale',
          },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_VERSION_CONFLICT' });

      // Reactivate SUSPENDED -> ACTIVE
      const reactivated = await service.updateStatus(
        member.id,
        {
          status: AccountStatus.ACTIVE,
          expectedVersion: 1,
          reason: 'Appeal approved',
        },
        asActor(admin),
      );
      expect(reactivated.status).toBe(AccountStatus.ACTIVE);
      expect(reactivated.accountVersion).toBe(2);

      const storedAudits = await audits()
        .find({ userId: member.id })
        .sort({ accountVersion: 1 })
        .exec();
      expect(storedAudits.map((a) => a.action)).toEqual([
        UserAccountAction.SUSPEND,
        UserAccountAction.REACTIVATE,
      ]);
    });

    it('rejects invalid transitions and suspending the last ACTIVE admin', async () => {
      const admin = await createUser(db, { role: UserRole.ADMIN });
      const pending = await createUser(db, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
      const unverifiedSuspended = await createUser(db, {
        status: AccountStatus.SUSPENDED,
        emailVerifiedAt: null,
      });

      await expect(
        service.updateStatus(
          pending.id,
          {
            status: AccountStatus.ACTIVE,
            expectedVersion: 0,
            reason: 'Bypass email',
          },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_TRANSITION' });

      await expect(
        service.updateStatus(
          pending.id,
          {
            status: AccountStatus.SUSPENDED,
            expectedVersion: 0,
            reason: 'Suspend pending',
          },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_TRANSITION' });

      await expect(
        service.updateStatus(
          unverifiedSuspended.id,
          {
            status: AccountStatus.ACTIVE,
            expectedVersion: 0,
            reason: 'Activate unverified',
          },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_TRANSITION' });

      await expect(
        service.updateStatus(
          admin.id,
          {
            status: AccountStatus.SUSPENDED,
            expectedVersion: 0,
            reason: 'Suspend sole admin',
          },
          asActor(admin),
        ),
      ).rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });

      const secondAdmin = await createUser(db, { role: UserRole.ADMIN });
      const suspendedSecond = await service.updateStatus(
        secondAdmin.id,
        {
          status: AccountStatus.SUSPENDED,
          expectedVersion: 0,
          reason: 'Temporary leave',
        },
        asActor(admin),
      );
      expect(suspendedSecond.status).toBe(AccountStatus.SUSPENDED);
    });
  });
});
