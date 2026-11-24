import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { FileTooLargeException } from '@src/common/exceptions/file-too-large.exception.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';
import { createPost, createUser } from '@test/support/fixtures.js';
import { NotificationsService } from '@src/notifications/notifications.service.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import type { PresignedUploadDto } from '@src/storage/presigned-upload.dto.js';
import { StorageService, StorageTarget } from '@src/storage/storage.service.js';
import {
  AccountStatus,
  Follow,
  Post,
  ProfileImageKind,
  ProfileImageStatus,
  ProfileImageUpload,
  User,
} from '@src/mongo/models.js';
import { ProfilesService } from '@src/profiles/profiles.service.js';
import { ProfileSearchIndexService } from '@src/profiles/search/profile-search-index.service.js';
import { ProfileSearchService } from '@src/profiles/search/profile-search.service.js';

const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const viewerId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const imageId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
const storageKey = `profiles/${userId}/avatar/${imageId}.webp`;
const publicUrl = `https://storage.vedora.vn/vedora-profiles/${storageKey}`;
const presigned: PresignedUploadDto = {
  url: 'https://storage.vedora.vn/vedora-profiles/profiles/x?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'content-type': 'image/webp' },
  expiresAt: new Date('2026-09-28T09:00:00Z'),
};

describe('ProfilesService', () => {
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
  const profileSearch = { search: vi.fn(), prune: vi.fn() };
  const profileSearchIndex = { schedule: vi.fn() };

  const users = () => db.connection.model<User>(User.name);
  const follows = () => db.connection.model<Follow>(Follow.name);
  const uploads = () =>
    db.connection.model<ProfileImageUpload>(ProfileImageUpload.name);
  const posts = () => db.connection.model<Post>(Post.name);

  const insertFollow = (followerId: string, followingId: string, at: Date) =>
    follows().create({
      _id: randomUUID(),
      followerId,
      followingId,
      createdAt: at,
    });

  const insertUpload = (fields: Record<string, unknown> = {}) =>
    uploads().create({
      _id: imageId,
      ownerId: userId,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.READY,
      storageKey,
      createdAt: new Date(),
      ...fields,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('profiles'))],
      providers: [
        ProfilesService,
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: notifications },
        { provide: ProfileSearchService, useValue: profileSearch },
        { provide: ProfileSearchIndexService, useValue: profileSearchIndex },
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
    storage.publicObjectUrl.mockReturnValue(publicUrl);
    await users().deleteMany({});
    await follows().deleteMany({});
    await uploads().deleteMany({});
    await posts().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('returns public fields and published-post/follow counts', async () => {
    await createUser(db, {
      id: userId,
      username: 'vedora.user',
      fullName: 'Vedora User',
      bio: 'Plant based cooking',
      emailVerifiedAt: new Date(),
    });
    for (let index = 0; index < 3; index++) {
      await createPost(db, { authorId: userId });
    }
    for (let index = 0; index < 5; index++) {
      const follower = await createUser(db);
      await insertFollow(follower.id, userId, new Date());
    }
    for (let index = 0; index < 2; index++) {
      const following = await createUser(db);
      await insertFollow(userId, following.id, new Date());
    }

    const profile = await service.findOne(userId);

    expect(profile).toMatchObject({
      id: userId,
      username: 'vedora.user',
      postCount: 3,
      followerCount: 5,
      followingCount: 2,
    });
    expect(profile).not.toHaveProperty('email');
  });

  it('does not expose unverified accounts', async () => {
    await createUser(db, { id: userId, emailVerifiedAt: null });

    await expect(service.findOne(userId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('rejects self-follow and writes other follows idempotently', async () => {
    await createUser(db, { id: userId });
    await createUser(db, { id: viewerId });

    await expect(service.follow(userId, userId)).rejects.toBeInstanceOf(
      InvalidInputException,
    );
    await service.follow(userId, viewerId);
    expect(notifications.notify).toHaveBeenCalledWith({
      recipientId: userId,
      actorId: viewerId,
      type: 'FOLLOW',
    });
    notifications.notify.mockClear();
    await service.follow(userId, viewerId);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(await follows().countDocuments()).toBe(1);
    await service.unfollow(userId, viewerId);
    expect(await follows().countDocuments()).toBe(0);
  });

  it('paginates followers by the last returned user ID', async () => {
    await createUser(db, { id: userId });
    const first = await createUser(db, { id: viewerId });
    const second = await createUser(db);
    await insertFollow(first.id, userId, new Date('2026-09-01T10:00:00Z'));
    await insertFollow(second.id, userId, new Date('2026-09-02T10:00:00Z'));

    const page = await service.followers(userId, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(second.id);
    expect(page.nextCursor).toBe(second.id);
    const rest = await service.followers(userId, {
      limit: 5,
      cursor: second.id,
    });
    expect(rest.items.map((item) => item.id)).toEqual([first.id]);
  });

  it('drops unverified accounts from follower lists', async () => {
    await createUser(db, { id: userId });
    const hidden = await createUser(db, { emailVerifiedAt: null });
    await insertFollow(hidden.id, userId, new Date());

    const page = await service.followers(userId, { limit: 5 });

    expect(page.items).toEqual([]);
  });

  it('presigns an upload scoped to the owner, kind, type and size', async () => {
    storage.presignUpload.mockResolvedValue(presigned);

    const result = await service.createImageUpload(userId, {
      kind: ProfileImageKind.COVER,
      contentType: 'image/webp',
      sizeBytes: 1000,
    });

    const key = `profiles/${userId}/cover/${result.id}.webp`;
    expect(storage.presignUpload).toHaveBeenCalledWith(
      StorageTarget.Profiles,
      key,
      'image/webp',
      1000,
    );
    expect(await uploads().findOne({ _id: result.id })).toMatchObject({
      ownerId: userId,
      storageKey: key,
      status: 'WAITING_UPLOAD',
    });
    expect(result.upload).toBe(presigned);
  });

  it('refuses images over the size limit before presigning', async () => {
    await expect(
      service.createImageUpload(userId, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/webp',
        sizeBytes: 5 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeException);
    expect(storage.presignUpload).not.toHaveBeenCalled();
  });

  it('refuses unsupported image types', async () => {
    await expect(
      service.createImageUpload(userId, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/gif' as 'image/webp',
        sizeBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(InvalidInputException);
  });

  it('only activates a confirmed upload owned by the caller', async () => {
    await createUser(db, { id: userId });

    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await insertUpload({ status: 'WAITING_UPLOAD' });
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      StateConflictException,
    );
    await uploads().updateOne({ _id: imageId }, { $set: { status: 'READY' } });

    const profile = await service.activateImage(userId, imageId);

    expect(profile.avatarUrl).toBe(publicUrl);
    expect(await users().findOne({ _id: userId })).toMatchObject({
      avatarUrl: publicUrl,
    });
  });

  it('refuses an expired upload', async () => {
    await createUser(db, { id: userId });
    await insertUpload({ createdAt: new Date('2026-01-01T00:00:00Z') });

    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      StateConflictException,
    );
  });

  it('marks only a waiting upload with that key ready', async () => {
    await insertUpload({ status: 'WAITING_UPLOAD' });

    await service.markImageUploaded(storageKey);

    expect(await uploads().findOne({ _id: imageId })).toMatchObject({
      status: 'READY',
    });
    await uploads().updateOne({ _id: imageId }, { $set: { status: 'READY' } });
    await service.markImageUploaded(storageKey);
    expect(await uploads().findOne({ _id: imageId })).toMatchObject({
      status: 'READY',
    });
  });

  it('keeps active images and purges old unused uploads', async () => {
    await createUser(db, { id: userId, avatarUrl: publicUrl });
    const old = new Date('2026-01-01T00:00:00Z');
    await insertUpload({ createdAt: old });
    const unusedKey = 'profiles/unused.webp';
    await uploads().create({
      _id: viewerId,
      ownerId: null,
      kind: ProfileImageKind.AVATAR,
      status: ProfileImageStatus.READY,
      storageKey: unusedKey,
      createdAt: old,
    });
    storage.publicObjectUrl.mockImplementation(
      (_target: StorageTarget, key: string) =>
        key === storageKey ? publicUrl : `https://storage/${key}`,
    );

    await service.purgeUnusedImages();

    expect(storage.delete).toHaveBeenCalledWith(
      StorageTarget.Profiles,
      unusedKey,
    );
    expect(storage.delete).not.toHaveBeenCalledWith(
      StorageTarget.Profiles,
      storageKey,
    );
    expect(await uploads().countDocuments()).toBe(1);
  });

  it('does nothing when storage is not configured', async () => {
    storage.isConfigured.mockReturnValue(false);

    await service.purgeUnusedImages();

    expect(uploads).toBeDefined();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('hydrates BM25 search results in rank order, includes isFollowing, and prunes ineligible ids', async () => {
    const deletedId = '11111111-1111-4111-8111-111111111111';
    const viewer = await createUser(db, {
      id: viewerId,
      username: 'viewer.cook',
      fullName: 'Viewer Cook',
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
    });
    const first = await createUser(db, {
      id: userId,
      username: 'an.nguyen',
      fullName: 'Nguyễn An',
      bio: 'Bếp chay',
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
    });
    const suspended = await createUser(db, {
      username: 'suspended.an',
      fullName: 'Suspended An',
      emailVerifiedAt: new Date(),
      status: AccountStatus.SUSPENDED,
    });
    await insertFollow(viewer.id, first.id, new Date());
    profileSearch.search.mockResolvedValue({
      ids: [first.id, viewer.id, suspended.id, deletedId],
      hasMore: true,
    });
    profileSearch.prune.mockResolvedValue();

    const page = await service.search({ q: 'an', limit: 10 }, viewer.id);

    expect(page.items).toEqual([
      expect.objectContaining({
        id: first.id,
        username: 'an.nguyen',
        fullName: 'Nguyễn An',
        isFollowing: true,
      }),
      expect.objectContaining({
        id: viewer.id,
        isFollowing: false,
      }),
    ]);
    expect(page.nextCursor).toBe('10');
    expect(profileSearch.prune).toHaveBeenCalledWith([suspended.id, deletedId]);

    const guestPage = await service.search({ q: 'an', limit: 10 });
    expect(guestPage.items.map((item) => item.isFollowing)).toEqual([
      false,
      false,
    ]);
  });

  it('clears searchIndexedAt and schedules reindexing when profile text changes', async () => {
    await createUser(db, {
      id: userId,
      username: 'vedora.user',
      fullName: 'Old Name',
      emailVerifiedAt: new Date(),
      searchIndexedAt: new Date(),
    });

    await service.updateMe(userId, { fullName: 'New Name', bio: 'Món chay' });

    expect(
      (await users().findOne({ _id: userId }))?.searchIndexedAt,
    ).toBeNull();
    expect(profileSearchIndex.schedule).toHaveBeenCalledOnce();
  });
});
