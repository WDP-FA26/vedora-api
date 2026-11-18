import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { RefreshTokensService } from '../../../src/auth/refresh-tokens.service.js';
import { UnauthenticatedException } from '../../../src/common/exceptions/unauthenticated.exception.js';
import {
  AccountStatus,
  RefreshToken,
  User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const TTL_SECONDS = 3600;
const GRACE_SECONDS = 30;
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('RefreshTokensService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: RefreshTokensService;

  const tokens = () => db.connection.model<RefreshToken>(RefreshToken.name);
  const users = () => db.connection.model<User>(User.name);
  const tokenDoc = (token: string) =>
    tokens()
      .findOne({ tokenHash: sha256(token) })
      .exec();
  /** Moves a rotation back in time, past the reuse grace period. */
  const ageRotation = (token: string, seconds: number) =>
    tokens().updateOne(
      { tokenHash: sha256(token) },
      { $set: { revokedAt: new Date(Date.now() - seconds * 1000) } },
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('refreshtokens'))],
      providers: [
        RefreshTokensService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            REFRESH_TOKEN_TTL: TTL_SECONDS,
            REFRESH_TOKEN_REUSE_GRACE_SECONDS: GRACE_SECONDS,
            JWT_SECRET: 'refresh-token-test-secret-of-32-chars-or-more',
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(RefreshTokensService);
  });

  beforeEach(async () => {
    await tokens().deleteMany({});
    await users().deleteMany({});
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('issue', () => {
    it('issues an opaque token and stores only its sha256 hash', async () => {
      const user = await createUser(db);

      const issued = await service.issue(user.id);

      expect(issued.expiresIn).toBe(TTL_SECONDS);
      expect(issued.token.length).toBeGreaterThan(20);
      const stored = await tokens().findOne({ userId: user.id }).exec();
      expect(stored).not.toBeNull();
      expect(stored?.tokenHash).toBe(sha256(issued.token));
      expect(stored?.tokenHash).not.toBe(issued.token);
      expect(stored?.revokedAt).toBeNull();
    });

    it('rejects issuing for a missing user', async () => {
      await expect(
        service.issue('00000000-0000-4000-8000-000000000099'),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof UnauthenticatedException &&
          error.code === 'UNAUTHORIZED',
      );
      expect(await tokens().countDocuments()).toBe(0);
    });

    it('rejects issuing for SUSPENDED, PENDING_EMAIL, or DELETED accounts', async () => {
      const suspended = await createUser(db, {
        status: AccountStatus.SUSPENDED,
      });
      const pending = await createUser(db, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
      const deleted = await createUser(db, { status: AccountStatus.DELETED });

      await expect(service.issue(suspended.id)).rejects.toMatchObject({
        code: 'ACCOUNT_SUSPENDED',
      });
      await expect(service.issue(pending.id)).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_ACTIVE',
      });
      await expect(service.issue(deleted.id)).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_ACTIVE',
      });
      expect(await tokens().countDocuments()).toBe(0);
    });
  });

  describe('rotate', () => {
    it('revokes the current token and issues a replacement in the same family', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      const firstDoc = await tokens()
        .findOne({ tokenHash: sha256(first.token) })
        .exec();

      const second = await service.rotate(first.token);

      expect(second.userId).toBe(user.id);
      expect(second.expiresIn).toBe(TTL_SECONDS);
      expect(second.token).not.toBe(first.token);

      const oldDoc = await tokens().findById(firstDoc?.id).exec();
      const newDoc = await tokens()
        .findOne({ tokenHash: sha256(second.token) })
        .exec();
      expect(oldDoc?.revokedAt).toBeInstanceOf(Date);
      expect(oldDoc?.revokedReason).toBe('ROTATED');
      expect(newDoc?.familyId).toBe(firstDoc?.familyId);
      expect(newDoc?.revokedAt).toBeNull();
    });

    it('rejects unknown tokens', async () => {
      await expect(service.rotate('does-not-exist')).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('marks an expired token revoked without revoking other tokens in the family', async () => {
      const user = await createUser(db);
      const issued = await service.issue(user.id);
      const rotated = await service.rotate(issued.token);

      // Force the active replacement token to look expired and reset the old one?
      // Instead, issue a second family member with an expired date in the same family.
      const activeDoc = await tokens()
        .findOne({ tokenHash: sha256(rotated.token) })
        .exec();
      if (!activeDoc) throw new Error('Expected active token document');
      await tokens().create({
        familyId: activeDoc.familyId,
        tokenHash: sha256('expired-sibling'),
        userId: user.id,
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      });

      await expect(service.rotate('expired-sibling')).rejects.toMatchObject({
        statusCode: 401,
        message: 'Refresh token expired',
      });

      const expiredDoc = await tokens()
        .findOne({ tokenHash: sha256('expired-sibling') })
        .exec();
      const stillActive = await tokens()
        .findOne({ tokenHash: sha256(rotated.token) })
        .exec();
      expect(expiredDoc?.revokedAt).toBeInstanceOf(Date);
      expect(expiredDoc?.revokedReason).toBe('EXPIRED');
      expect(stillActive?.revokedAt).toBeNull();
    });

    it('detects reuse of a revoked token and revokes the whole family', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      const second = await service.rotate(first.token);
      const otherSession = await service.issue(user.id);
      await ageRotation(first.token, GRACE_SECONDS + 1);

      await expect(service.rotate(first.token)).rejects.toMatchObject({
        statusCode: 401,
        message: 'Refresh token reuse detected',
      });

      const secondDoc = await tokens()
        .findOne({ tokenHash: sha256(second.token) })
        .exec();
      const otherDoc = await tokens()
        .findOne({ tokenHash: sha256(otherSession.token) })
        .exec();
      expect(secondDoc?.revokedAt).toBeInstanceOf(Date);
      expect(secondDoc?.revokedReason).toBe('REUSE_DETECTED');
      expect(otherDoc?.revokedAt).toBeNull();
    });

    it('gives concurrent rotations of one token the same replacement', async () => {
      const user = await createUser(db);
      const issued = await service.issue(user.id);

      const results = await Promise.all([
        service.rotate(issued.token),
        service.rotate(issued.token),
        service.rotate(issued.token),
      ]);

      expect(new Set(results.map(({ token }) => token)).size).toBe(1);
      expect(
        await tokens().countDocuments({ userId: user.id, revokedAt: null }),
      ).toBe(1);
      await expect(service.rotate(results[0].token)).resolves.toMatchObject({
        userId: user.id,
      });
    });

    it('reissues the same replacement when a just-rotated token is sent again', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      const second = await service.rotate(first.token);

      // The browser never stored `second` and sends `first` again.
      const again = await service.rotate(first.token);

      expect(again.token).toBe(second.token);
      expect((await tokenDoc(second.token))?.revokedAt).toBeNull();
      await expect(service.rotate(second.token)).resolves.toMatchObject({
        userId: user.id,
      });
    });

    it('only lets the most recent predecessor be sent again within the grace period', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      const second = await service.rotate(first.token);
      const third = await service.rotate(second.token);

      await expect(service.rotate(first.token)).rejects.toMatchObject({
        message: 'Refresh token reuse detected',
      });
      expect((await tokenDoc(third.token))?.revokedReason).toBe(
        'REUSE_DETECTED',
      );
    });

    it('revokes the family once the grace period has passed', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      const second = await service.rotate(first.token);
      await ageRotation(first.token, GRACE_SECONDS + 1);

      await expect(service.rotate(first.token)).rejects.toMatchObject({
        message: 'Refresh token reuse detected',
      });
      await expect(service.rotate(second.token)).rejects.toMatchObject({
        message: 'Refresh token reuse detected',
      });
    });

    it('never reissues a token revoked by logout, even right away', async () => {
      const user = await createUser(db);
      const first = await service.issue(user.id);
      await service.revoke(first.token);

      expect((await tokenDoc(first.token))?.revokedReason).toBe('LOGOUT');
      await expect(service.rotate(first.token)).rejects.toMatchObject({
        message: 'Refresh token reuse detected',
      });
    });

    it('rejects rotation if the user was suspended or deleted after issuance', async () => {
      const user = await createUser(db);
      const issued = await service.issue(user.id);
      await users().updateOne(
        { _id: user.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );

      await expect(service.rotate(issued.token)).rejects.toMatchObject({
        code: 'ACCOUNT_SUSPENDED',
      });
      const doc = await tokens()
        .findOne({ tokenHash: sha256(issued.token) })
        .exec();
      expect(doc?.revokedAt).toBeNull();

      const findOneSpy = vi.spyOn(users(), 'findOne').mockImplementationOnce(
        () =>
          ({
            select: () => ({
              session: () => ({ exec: () => Promise.resolve(null) }),
            }),
          }) as never,
      );
      await expect(service.rotate(issued.token)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Account no longer exists',
      });
      findOneSpy.mockRestore();

      await users().deleteOne({ _id: user.id });
      await expect(service.rotate(issued.token)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid refresh token',
      });
    });
  });

  describe('revoke and revokeAllForUser', () => {
    it('revokes the matching token family and ignores unknown tokens', async () => {
      const user = await createUser(db);
      const familyA1 = await service.issue(user.id);
      const familyA2 = await service.rotate(familyA1.token);
      const familyB = await service.issue(user.id);

      await expect(service.revoke('unknown-token')).resolves.toBeUndefined();
      await service.revoke(familyA2.token);

      const familyADocs = await tokens()
        .find({
          tokenHash: { $in: [sha256(familyA1.token), sha256(familyA2.token)] },
        })
        .exec();
      expect(familyADocs.every((doc) => doc.revokedAt instanceof Date)).toBe(
        true,
      );
      const familyBDoc = await tokens()
        .findOne({ tokenHash: sha256(familyB.token) })
        .exec();
      expect(familyBDoc?.revokedAt).toBeNull();
    });

    it('revokes all active tokens for a single user without affecting others', async () => {
      const alice = await createUser(db);
      const bob = await createUser(db);
      const aliceToken1 = await service.issue(alice.id);
      const aliceToken2 = await service.issue(alice.id);
      const bobToken = await service.issue(bob.id);

      await service.revokeAllForUser(alice.id);

      expect(
        await tokens().countDocuments({ userId: alice.id, revokedAt: null }),
      ).toBe(0);
      expect(
        await tokens().countDocuments({
          userId: bob.id,
          tokenHash: sha256(bobToken.token),
          revokedAt: null,
        }),
      ).toBe(1);
      await expect(service.rotate(aliceToken1.token)).rejects.toBeInstanceOf(
        UnauthenticatedException,
      );
      await expect(service.rotate(aliceToken2.token)).rejects.toBeInstanceOf(
        UnauthenticatedException,
      );
    });
  });
});
