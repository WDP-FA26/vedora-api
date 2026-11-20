import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '../../../src/common/exceptions/unauthenticated.exception.js';
import { FileTooLargeException } from '../../../src/common/exceptions/file-too-large.exception.js';
import { MessagingEventsService } from '../../../src/messaging/messaging-events.service.js';
import {
  AccountStatus,
  Follow,
  MessagingEventType,
  ProfileImageKind,
  ProfileImageStatus,
  ProfileImageUpload,
  User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { NotificationsService } from '../../../src/notifications/notifications.service.js';
import { ProfilesService } from '../../../src/profiles/profiles.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../src/storage/storage.service.js';
import { createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('ProfilesService flows', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: ProfilesService;

  const storage = {
    isConfigured: vi.fn(),
    presignUpload: vi.fn(),
    publicObjectUrl: vi.fn(),
    delete: vi.fn(),
  };
  const notifications = { notify: vi.fn() };
  const messagingEvents = { record: vi.fn() };

  const users = () => db.connection.model<User>(User.name);
  const follows = () => db.connection.model<Follow>(Follow.name);
  const uploads = () =>
    db.connection.model<ProfileImageUpload>(ProfileImageUpload.name);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('profilesflows'))],
      providers: [
        ProfilesService,
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: notifications },
        { provide: MessagingEventsService, useValue: messagingEvents },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(ProfilesService);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    storage.isConfigured.mockReturnValue(true);
    storage.presignUpload.mockResolvedValue({
      url: 'https://storage/put',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: new Date('2026-10-01T01:00:00Z'),
    });
    storage.publicObjectUrl.mockImplementation(
      (_target: StorageTarget, key: string) => `https://storage/${key}`,
    );
    await users().deleteMany({});
    await follows().deleteMany({});
    await uploads().deleteMany({});
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('updateMe', () => {
    it('trims fullName and bio, clears bio when whitespace-only, and supports partial updates', async () => {
      const user = await createUser(db, {
        fullName: 'Initial Name',
        bio: 'Old bio',
      });

      const updated = await service.updateMe(user.id, {
        fullName: '  Trimmed Chef  ',
        bio: '  Plant-based cook  ',
      });
      expect(updated.fullName).toBe('Trimmed Chef');
      expect(updated.bio).toBe('Plant-based cook');

      const clearedBio = await service.updateMe(user.id, { bio: '   ' });
      expect(clearedBio.fullName).toBe('Trimmed Chef');
      expect(clearedBio.bio).toBeNull();

      const onlyName = await service.updateMe(user.id, {
        fullName: 'Second Name',
      });
      expect(onlyName.fullName).toBe('Second Name');
      expect(onlyName.bio).toBeNull();
    });

    it('rejects whitespace-only fullName and unverified accounts', async () => {
      const verified = await createUser(db);
      const unverified = await createUser(db, { emailVerifiedAt: null });

      await expect(
        service.updateMe(verified.id, { fullName: '   ' }),
      ).rejects.toBeInstanceOf(InvalidInputException);

      await expect(
        service.updateMe(unverified.id, { fullName: 'Valid Name' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('relationship, follow, unfollow, and following', () => {
    it('reports relationship status accurately and rejects unverified targets', async () => {
      const alice = await createUser(db);
      const bob = await createUser(db);
      const unverified = await createUser(db, { emailVerifiedAt: null });

      await expect(service.relationship(alice.id, alice.id)).resolves.toEqual({
        isFollowing: false,
      });
      await expect(service.relationship(bob.id, alice.id)).resolves.toEqual({
        isFollowing: false,
      });

      await service.follow(bob.id, alice.id);
      await expect(service.relationship(bob.id, alice.id)).resolves.toEqual({
        isFollowing: true,
      });
      expect(messagingEvents.record).toHaveBeenCalledExactlyOnceWith(
        [bob.id, alice.id],
        { type: MessagingEventType.RELATIONSHIP_CHANGED },
        expect.anything(),
      );

      // Idempotent repeat follow does not emit a second relationship event
      messagingEvents.record.mockClear();
      await service.follow(bob.id, alice.id);
      expect(messagingEvents.record).not.toHaveBeenCalled();

      // Unfollow records event only when a row was deleted
      await service.unfollow(bob.id, alice.id);
      expect(messagingEvents.record).toHaveBeenCalledExactlyOnceWith(
        [bob.id, alice.id],
        { type: MessagingEventType.RELATIONSHIP_CHANGED },
        expect.anything(),
      );
      messagingEvents.record.mockClear();
      await service.unfollow(bob.id, alice.id);
      expect(messagingEvents.record).not.toHaveBeenCalled();

      await expect(
        service.relationship(unverified.id, alice.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.unfollow(unverified.id, alice.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('rejects follow when follower is suspended, missing, or target is unverified', async () => {
      const target = await createUser(db);
      const unverifiedTarget = await createUser(db, { emailVerifiedAt: null });
      const suspended = await createUser(db, {
        status: AccountStatus.SUSPENDED,
      });

      await expect(service.follow(target.id, suspended.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof UnauthenticatedException &&
          error.code === 'ACCOUNT_SUSPENDED',
      );

      await expect(
        service.follow(target.id, randomUUID()),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await expect(
        service.follow(unverifiedTarget.id, target.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('paginates following newest first, drops unverified accounts, and handles unknown cursors', async () => {
      const alice = await createUser(db);
      const bob = await createUser(db);
      const carol = await createUser(db);
      const unverified = await createUser(db, { emailVerifiedAt: null });

      await follows().create([
        {
          _id: randomUUID(),
          followerId: alice.id,
          followingId: bob.id,
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
        {
          _id: randomUUID(),
          followerId: alice.id,
          followingId: carol.id,
          createdAt: new Date('2026-10-02T10:00:00Z'),
        },
      ]);

      const page1 = await service.following(alice.id, { limit: 1 });
      expect(page1.items.map((u) => u.id)).toEqual([carol.id]);
      expect(page1.nextCursor).toBe(carol.id);

      const page2 = await service.following(alice.id, {
        limit: 5,
        cursor: carol.id,
      });
      expect(page2.items.map((u) => u.id)).toEqual([bob.id]);
      expect(page2.nextCursor).toBeNull();

      await follows().create({
        _id: randomUUID(),
        followerId: alice.id,
        followingId: unverified.id,
        createdAt: new Date('2026-10-03T10:00:00Z'),
      });

      const allVerified = await service.following(alice.id, { limit: 5 });
      expect(allVerified.items.map((u) => u.id)).toEqual([carol.id, bob.id]);

      await expect(
        service.following(alice.id, { limit: 5, cursor: randomUUID() }),
      ).resolves.toEqual({ items: [], nextCursor: null });
      await expect(
        service.followers(alice.id, { limit: 5, cursor: randomUUID() }),
      ).resolves.toEqual({ items: [], nextCursor: null });
    });

    // BUG-L-A4: following() filters unverified accounts after limit+1 fetch,
    // causing nextCursor to become null early when an unverified user sits in lookahead.
    it('keeps paging past an unverified account in following list', async () => {
      const alice = await createUser(db);
      const bob = await createUser(db);
      const carol = await createUser(db);
      const unverified = await createUser(db, { emailVerifiedAt: null });

      await follows().create([
        {
          _id: randomUUID(),
          followerId: alice.id,
          followingId: bob.id,
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
        {
          _id: randomUUID(),
          followerId: alice.id,
          followingId: carol.id,
          createdAt: new Date('2026-10-02T10:00:00Z'),
        },
        {
          _id: randomUUID(),
          followerId: alice.id,
          followingId: unverified.id,
          createdAt: new Date('2026-10-03T10:00:00Z'),
        },
      ]);

      const page1 = await service.following(alice.id, { limit: 1 });
      expect(page1.items.map((u) => u.id)).toEqual([carol.id]);
      expect(page1.nextCursor).toBe(carol.id);
    });
  });

  describe('images: upload, activate, clear, and purge', () => {
    it('supports jpeg/png uploads up to kind-specific byte boundaries', async () => {
      const user = await createUser(db);

      const avatarMax = await service.createImageUpload(user.id, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/jpeg',
        sizeBytes: 5 * 1024 * 1024,
      });
      expect(storage.presignUpload).toHaveBeenCalledWith(
        StorageTarget.Profiles,
        `profiles/${user.id}/avatar/${avatarMax.id}.jpg`,
        'image/jpeg',
        5 * 1024 * 1024,
      );

      const coverMax = await service.createImageUpload(user.id, {
        kind: ProfileImageKind.COVER,
        contentType: 'image/png',
        sizeBytes: 10 * 1024 * 1024,
      });
      expect(storage.presignUpload).toHaveBeenCalledWith(
        StorageTarget.Profiles,
        `profiles/${user.id}/cover/${coverMax.id}.png`,
        'image/png',
        10 * 1024 * 1024,
      );

      await expect(
        service.createImageUpload(user.id, {
          kind: ProfileImageKind.COVER,
          contentType: 'image/png',
          sizeBytes: 10 * 1024 * 1024 + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);
    });

    it('activates COVER images, enforces ownership, and clears AVATAR or COVER', async () => {
      const owner = await createUser(db, {
        avatarUrl: 'https://storage/old-avatar.jpg',
      });
      const stranger = await createUser(db);
      const coverKey = `profiles/${owner.id}/cover/cover-1.webp`;
      const uploadId = randomUUID();
      await uploads().create({
        _id: uploadId,
        ownerId: owner.id,
        kind: ProfileImageKind.COVER,
        status: ProfileImageStatus.READY,
        storageKey: coverKey,
      });

      await expect(
        service.activateImage(stranger.id, uploadId),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      const withCover = await service.activateImage(owner.id, uploadId);
      expect(withCover.coverUrl).toBe(`https://storage/${coverKey}`);

      const noAvatar = await service.clearImage(
        owner.id,
        ProfileImageKind.AVATAR,
      );
      expect(noAvatar.avatarUrl).toBeNull();
      expect(noAvatar.coverUrl).toBe(`https://storage/${coverKey}`);

      const noCover = await service.clearImage(
        owner.id,
        ProfileImageKind.COVER,
      );
      expect(noCover.coverUrl).toBeNull();
    });

    it('keeps cover images in use and retains rows when storage.delete fails', async () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const coverKey = 'profiles/u/cover/active.webp';
      const failingKey = 'profiles/u/avatar/failing.webp';
      await createUser(db, { coverUrl: `https://storage/${coverKey}` });
      await uploads().create([
        {
          _id: randomUUID(),
          ownerId: null,
          kind: ProfileImageKind.COVER,
          status: ProfileImageStatus.READY,
          storageKey: coverKey,
          createdAt: old,
        },
        {
          _id: randomUUID(),
          ownerId: null,
          kind: ProfileImageKind.AVATAR,
          status: ProfileImageStatus.READY,
          storageKey: failingKey,
          createdAt: old,
        },
      ]);
      storage.delete.mockRejectedValueOnce(new Error('S3 offline'));

      await service.purgeUnusedImages();

      expect(storage.delete).toHaveBeenCalledExactlyOnceWith(
        StorageTarget.Profiles,
        failingKey,
      );
      expect(await uploads().countDocuments()).toBe(2);
    });
  });
});
