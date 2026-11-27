import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { compare } from 'bcryptjs';
import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import { AccountStatus, User, UserRole } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { AccountsService } from '@src/users/accounts.service.js';
import { createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

describe('AccountsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AccountsService;

  const users = () => db.connection.model<User>(User.name);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('accounts'))],
      providers: [AccountsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AccountsService);
  });

  beforeEach(async () => {
    await users().deleteMany({});
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('create and createWithPassword', () => {
    it('creates a PENDING_EMAIL USER with defaults and strips private fields', async () => {
      const created = await service.create({
        username: 'vedora.user',
        fullName: 'Vedora User',
        email: 'hello@vedora.vn',
      });

      expect(created).toMatchObject({
        username: 'vedora.user',
        fullName: 'Vedora User',
        email: 'hello@vedora.vn',
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
        accountVersion: 0,
      });
      expect(created).not.toHaveProperty('passwordHash');
      expect(created).not.toHaveProperty('googleId');
    });

    it('hashes password in createWithPassword and rejects passwords > 72 bytes', async () => {
      const created = await service.createWithPassword({
        username: 'chef.one',
        password: 'StrongPassword123!',
        fullName: 'Chef One',
        email: 'chef1@vedora.vn',
      });

      const stored = await users().findById(created.id).exec();
      expect(stored?.passwordHash).toEqual(expect.any(String));
      await expect(
        compare('StrongPassword123!', stored?.passwordHash as string),
      ).resolves.toBe(true);

      await expect(
        service.createWithPassword({
          username: 'chef.two',
          password: 'a'.repeat(73),
          fullName: 'Chef Two',
          email: 'chef2@vedora.vn',
        }),
      ).rejects.toBeInstanceOf(InvalidInputException);
    });

    it('translates duplicate username or email into StateConflictException', async () => {
      await service.create({
        username: 'dup.user',
        fullName: 'First',
        email: 'first@vedora.vn',
      });

      await expect(
        service.create({
          username: 'dup.user',
          fullName: 'Second',
          email: 'second@vedora.vn',
        }),
      ).rejects.toBeInstanceOf(StateConflictException);

      await expect(
        service.create({
          username: 'other.user',
          fullName: 'Third',
          email: 'first@vedora.vn',
        }),
      ).rejects.toBeInstanceOf(StateConflictException);
    });
  });

  describe('lookups', () => {
    it('finds users by username, googleId, email, and public id, returning null when absent', async () => {
      const user = await createUser(db, {
        username: 'lookup.user',
        email: 'lookup@vedora.vn',
        googleId: 'google-123',
        passwordHash: 'hashed-secret',
      });

      expect((await service.findByUsername('lookup.user'))?.id).toBe(user.id);
      expect(await service.findByUsername('missing')).toBeNull();

      expect((await service.findByGoogleId('google-123'))?.id).toBe(user.id);
      expect(await service.findByGoogleId('missing')).toBeNull();

      expect((await service.findByEmail('lookup@vedora.vn'))?.id).toBe(user.id);
      expect(await service.findByEmail('missing@vedora.vn')).toBeNull();

      const pub = await service.findPublicById(user.id);
      expect(pub?.id).toBe(user.id);
      expect(pub).not.toHaveProperty('passwordHash');
      expect(pub).not.toHaveProperty('googleId');
      expect(await service.findPublicById('missing-id')).toBeNull();
    });
  });

  describe('linkGoogleAccount', () => {
    it('links Google to a verified ACTIVE account while keeping its passwordHash', async () => {
      const verifiedAt = new Date('2026-10-01T00:00:00Z');
      const user = await createUser(db, {
        status: AccountStatus.ACTIVE,
        emailVerifiedAt: verifiedAt,
        passwordHash: 'existing-hash',
      });

      const linked = await service.linkGoogleAccount(user, 'google-verified');

      expect(linked.status).toBe(AccountStatus.ACTIVE);
      const stored = await users().findById(user.id).exec();
      expect(stored?.googleId).toBe('google-verified');
      expect(stored?.passwordHash).toBe('existing-hash');
      expect(stored?.emailVerifiedAt?.toISOString()).toBe(
        verifiedAt.toISOString(),
      );
    });

    it('verifies and wipes passwordHash when linking Google to an unverified account', async () => {
      const pending = await createUser(db, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
        passwordHash: 'attacker-hash',
      });

      const linked = await service.linkGoogleAccount(pending, 'google-pending');

      expect(linked.status).toBe(AccountStatus.ACTIVE);
      const stored = await users().findById(pending.id).exec();
      expect(stored?.googleId).toBe('google-pending');
      expect(stored?.passwordHash).toBeNull();
      expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('rejects linking for SUSPENDED or DELETED accounts', async () => {
      const suspended = await createUser(db, {
        status: AccountStatus.SUSPENDED,
      });
      const deleted = await createUser(db, {
        status: AccountStatus.DELETED,
      });

      await expect(
        service.linkGoogleAccount(suspended, 'g-susp'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.linkGoogleAccount(deleted, 'g-del'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('throws StateConflictException when googleId is already linked elsewhere', async () => {
      await createUser(db, { googleId: 'taken-google-id' });
      const second = await createUser(db, { status: AccountStatus.ACTIVE });

      await expect(
        service.linkGoogleAccount(second, 'taken-google-id'),
      ).rejects.toBeInstanceOf(StateConflictException);
    });
  });

  describe('deleteStaleUnverified', () => {
    it('deletes only stale unverified non-Google USER accounts matching email or username', async () => {
      const oldDate = new Date('2026-01-01T00:00:00Z');
      const cutoff = new Date('2026-06-01T00:00:00Z');

      const staleByEmail = await createUser(db, {
        username: 'other.one',
        email: 'target@vedora.vn',
        emailVerifiedAt: null,
        googleId: null,
        status: AccountStatus.PENDING_EMAIL,
      });
      const staleByUsername = await createUser(db, {
        username: 'target.user',
        email: 'other1@vedora.vn',
        emailVerifiedAt: null,
        googleId: null,
        status: AccountStatus.PENDING_EMAIL,
      });
      const freshPending = await createUser(db, {
        username: 'fresh.pending',
        email: 'fresh@vedora.vn',
        emailVerifiedAt: null,
        googleId: null,
        status: AccountStatus.PENDING_EMAIL,
      });
      const verifiedMatch = await createUser(db, {
        username: 'verified.match',
        email: 'verified@vedora.vn',
        emailVerifiedAt: new Date(),
        status: AccountStatus.ACTIVE,
      });
      const adminPending = await createUser(db, {
        username: 'admin.pending',
        email: 'adminpending@vedora.vn',
        role: UserRole.ADMIN,
        emailVerifiedAt: null,
        status: AccountStatus.PENDING_EMAIL,
      });

      await users().collection.updateMany(
        {
          _id: {
            $in: [
              staleByEmail.id,
              staleByUsername.id,
              verifiedMatch.id,
              adminPending.id,
            ],
          },
        },
        { $set: { createdAt: oldDate } },
      );

      await service.deleteStaleUnverified(
        { email: 'target@vedora.vn', username: 'target.user' },
        cutoff,
      );
      const freshMatch = await createUser(db, {
        username: 'fresh.match',
        email: 'freshmatch@vedora.vn',
        emailVerifiedAt: null,
        googleId: null,
        status: AccountStatus.PENDING_EMAIL,
      });
      await service.deleteStaleUnverified(
        { email: 'freshmatch@vedora.vn', username: 'verified.match' },
        cutoff,
      );
      await service.deleteStaleUnverified(
        { email: 'adminpending@vedora.vn', username: 'admin.pending' },
        cutoff,
      );

      expect(await users().findById(staleByEmail.id).exec()).toBeNull();
      expect(await users().findById(staleByUsername.id).exec()).toBeNull();
      expect(await users().findById(freshPending.id).exec()).not.toBeNull();
      expect(await users().findById(freshMatch.id).exec()).not.toBeNull();
      expect(await users().findById(verifiedMatch.id).exec()).not.toBeNull();
      expect(await users().findById(adminPending.id).exec()).not.toBeNull();
    });
  });
});
