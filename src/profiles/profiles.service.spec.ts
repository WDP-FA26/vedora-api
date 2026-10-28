import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { createPost, createUser } from '../../test/fixtures.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import type { PresignedUploadDto } from '../storage/presigned-upload.dto.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  Follow,
  Post,
  ProfileImageKind,
  ProfileImageStatus,
  ProfileImageUpload,
  User,
} from '../mongo/models.js';
import { ProfilesService } from './profiles.service.js';

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
      NotFoundException,
    );
  });

  it('rejects self-follow and writes other follows idempotently', async () => {
    await createUser(db, { id: userId });
    await createUser(db, { id: viewerId });

    await expect(service.follow(userId, userId)).rejects.toBeInstanceOf(
      BadRequestException,
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
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(storage.presignUpload).not.toHaveBeenCalled();
  });

  it('refuses unsupported image types', async () => {
    await expect(
      service.createImageUpload(userId, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/gif' as 'image/webp',
        sizeBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only activates a confirmed upload owned by the caller', async () => {
    await createUser(db, { id: userId });

    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await insertUpload({ status: 'WAITING_UPLOAD' });
    await expect(service.activateImage(userId, imageId)).rejects.toBeInstanceOf(
      ConflictException,
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
      ConflictException,
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
});
