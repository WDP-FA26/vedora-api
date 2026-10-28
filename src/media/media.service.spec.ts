import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ClientSession } from 'mongoose';
import type { MockInstance } from 'vitest';
import { createMedia, createPost, createUser } from '../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  CaptionStatus,
  type MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  type Post,
  PostStatus,
} from '../mongo/models.js';
import { CaptionService } from './caption.service.js';
import {
  mediaId,
  ownerId,
  publicId,
  streamBuilt,
  uploaded,
} from './media.fixtures.js';
import { MediaService } from './media.service.js';

describe('MediaService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: MediaService;
  let findVideo: MockInstance<CloudinaryService['findVideo']>;
  let deleteMedia: MockInstance<CloudinaryService['deleteMedia']>;
  let schedule: ReturnType<typeof vi.fn>;
  let postId: string;

  const assets = () => db.connection.model<MediaAsset>('MediaAsset');
  const posts = () => db.connection.model<Post>('Post');
  const media = () => assets().findById(mediaId).exec();
  const post = () => posts().findById(postId).exec();
  /** The row the upload endpoint leaves, in `fields`. */
  const addMedia = (fields: Partial<MediaAsset> = {}) =>
    createMedia(db, { id: mediaId, publicId, ownerId, ...fields });
  const claim = (ids: string[]) =>
    db.withTransaction((session: ClientSession) =>
      service.claimForPost(session, ownerId, postId, ids),
    );

  beforeAll(async () => {
    schedule = vi.fn();
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('mediaservice'))],
      providers: [
        MediaService,
        CloudinaryService,
        { provide: CaptionService, useValue: { schedule } },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CLOUDINARY_CLOUD_NAME: 'demo',
            CLOUDINARY_API_KEY: 'key',
            CLOUDINARY_API_SECRET: 'secret',
            MAX_VIDEO_DURATION_SEC: 180,
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(MediaService);
    // The real CloudinaryService signs and builds URLs; only its API calls
    // are mocked.
    const cloudinary = app.get(CloudinaryService);
    findVideo = vi.spyOn(cloudinary, 'findVideo').mockResolvedValue(null);
    deleteMedia = vi.spyOn(cloudinary, 'deleteMedia').mockResolvedValue();
    await createUser(db, { id: ownerId });
  });
  beforeEach(async () => {
    await assets().deleteMany({});
    await posts().deleteMany({});
    schedule.mockClear();
    findVideo.mockReset();
    findVideo.mockResolvedValue(null);
    deleteMedia.mockReset();
    deleteMedia.mockResolvedValue();
    postId = (
      await createPost(db, {
        authorId: ownerId,
        status: PostStatus.PROCESSING,
        publishedAt: null,
      })
    ).id;
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('signs an upload that pins the public ID and the HLS job', async () => {
    const created = await service.createUpload(ownerId, MediaType.VIDEO);

    expect(created.media.publicId).toBe(`vedora/videos/${created.media.id}`);
    expect(created.upload.url).toBe(
      'https://api.cloudinary.com/v1_1/demo/video/upload',
    );
    expect(created.upload.fields).toMatchObject({
      public_id: created.media.publicId,
      eager: 'sp_auto/m3u8',
      eager_async: 'true',
      api_key: 'key',
    });
    expect(created.upload.fields.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(await assets().countDocuments()).toBe(1);
  });

  it('limits the uploads one account may leave unattached', async () => {
    for (let upload = 0; upload < 5; upload++) {
      await service.createUpload(ownerId, MediaType.VIDEO);
    }
    await expect(
      service.createUpload(ownerId, MediaType.VIDEO),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('records the upload and waits for the stream', async () => {
    await addMedia({ postId });

    await service.handleNotification(uploaded(42));

    expect(await media()).toMatchObject({
      status: MediaStatus.PROCESSING,
      durationSec: 42,
      aspectRatio: '9:16',
    });
    expect((await post())?.status).toBe(PostStatus.PROCESSING);
  });

  it('marks media READY and publishes its post once the stream is built', async () => {
    await addMedia({ postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    expect((await media())?.status).toBe(MediaStatus.READY);
    expect(await post()).toMatchObject({
      status: PostStatus.PUBLISHED,
      publishedAt: expect.any(Date) as Date,
    });
    expect(schedule).toHaveBeenCalled();
  });

  it('waits for every video of a post before publishing it', async () => {
    await addMedia({ postId, status: MediaStatus.PROCESSING });
    await createMedia(db, { postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    expect((await media())?.status).toBe(MediaStatus.READY);
    expect((await post())?.status).toBe(PostStatus.PROCESSING);
  });

  it('fails the post when one of its videos fails', async () => {
    await addMedia({ postId, status: MediaStatus.PROCESSING });
    await createMedia(db, { postId, status: MediaStatus.READY });

    await service.handleNotification({
      ...streamBuilt(),
      eager: [{ status: 'failed' }],
    });

    expect(await media()).toMatchObject({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.ENCODING_FAILED,
    });
    expect((await post())?.status).toBe(PostStatus.FAILED);
  });

  it('reads the upload details when the stream finishes first', async () => {
    await addMedia({ postId });
    findVideo.mockResolvedValue({ public_id: publicId, duration: 42 });

    await service.handleNotification(streamBuilt());

    expect(findVideo).toHaveBeenCalledWith(publicId);
    expect(await media()).toMatchObject({
      status: MediaStatus.READY,
      durationSec: 42,
    });
  });

  it('ignores a replayed stream notification for media that is already READY', async () => {
    await addMedia({ postId, status: MediaStatus.READY });

    await service.handleNotification(streamBuilt());

    expect((await media())?.status).toBe(MediaStatus.READY);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('ignores files outside the videos folder', async () => {
    await addMedia();

    await service.handleNotification({
      ...uploaded(42),
      public_id: 'someone-else/clip',
    });

    expect((await media())?.status).toBe(MediaStatus.WAITING_UPLOAD);
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it('fails videos over the duration limit and deletes them', async () => {
    await addMedia({ postId });

    await service.handleNotification(uploaded(181));

    expect(await media()).toMatchObject({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.TOO_LONG,
    });
    expect((await post())?.status).toBe(PostStatus.FAILED);
    expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
  });

  it('deletes a file whose row is already gone', async () => {
    await service.handleNotification(uploaded(42));

    expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
    expect(await assets().countDocuments()).toBe(0);
  });

  describe('attaching to a post', () => {
    it('gives each upload its position in the post', async () => {
      const second = await createMedia(db, { ownerId });
      await addMedia();

      await claim([mediaId, second.id]);

      const attached = await assets().find({ postId }).sort({ position: 1 });
      expect(attached.map(({ id }) => id)).toEqual([mediaId, second.id]);
    });

    it.each([
      ['someone else’s upload', { ownerId: 'someone-else' }],
      ['an upload another post uses', { postId: 'another-post' }],
      ['a failed upload', { status: MediaStatus.FAILED }],
    ])('refuses %s and attaches nothing', async (_case, fields) => {
      const fine = await createMedia(db, { ownerId });
      await addMedia(fields);

      await expect(claim([fine.id, mediaId])).rejects.toMatchObject({
        code: 'MEDIA_UNAVAILABLE',
      });

      const stored = await assets().findById(fine.id).exec();
      expect(stored?.postId).toBeNull();
    });
  });

  describe('polling without notifications', () => {
    it('publishes once the Admin API lists the HLS stream', async () => {
      const row = await addMedia({ postId, status: MediaStatus.PROCESSING });
      findVideo.mockResolvedValue({
        public_id: publicId,
        duration: 42,
        derived: [{ transformation: 'sp_auto/pg_1/m3u8', format: 'm3u8' }],
      });

      await service.refresh(row);

      expect((await media())?.status).toBe(MediaStatus.READY);
      expect((await post())?.status).toBe(PostStatus.PUBLISHED);
    });

    it('asks the Admin API at most every 15 seconds per video', async () => {
      const fresh = await addMedia();
      await service.refresh(fresh);
      await service.refresh(fresh);

      expect(findVideo).toHaveBeenCalledTimes(1);
    });

    it('times out an upload whose file never arrived', async () => {
      const row = await createMedia(db, { postId });
      // `createdAt` is immutable to Mongoose, so backdate it as stored.
      await assets().updateOne(
        { _id: row.id },
        { $set: { createdAt: new Date('2026-09-24T00:00:00Z') } },
        { timestamps: false, overwriteImmutable: true },
      );

      await service.refresh((await assets().findById(row.id).exec())!);

      expect(await assets().findById(row.id).exec()).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.UPLOAD_TIMED_OUT,
      });
    });
  });

  describe('discarding', () => {
    const old = new Date('2026-09-24T00:00:00Z');

    it('hides the upload, deletes it from Cloudinary, then drops the row', async () => {
      await addMedia({ status: MediaStatus.PROCESSING, createdAt: old });

      await service.removeOwned(mediaId, ownerId);

      expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
      expect(await assets().countDocuments()).toBe(0);
    });

    it('refuses to discard an upload a post uses', async () => {
      await addMedia({ postId });

      await expect(service.removeOwned(mediaId, ownerId)).rejects.toMatchObject(
        { statusCode: 409 },
      );
    });

    it('also deletes the captions of a transcribed video', async () => {
      const row = await addMedia({
        captionStatus: CaptionStatus.READY,
        discardedAt: old,
      });

      await service.purge(row);

      expect(deleteMedia).toHaveBeenCalledWith(mediaId, true);
    });

    it('keeps the row while its upload could still finish', async () => {
      const row = await addMedia({
        status: MediaStatus.WAITING_UPLOAD,
        discardedAt: old,
      });
      await assets().updateOne(
        { _id: row.id },
        { $set: { createdAt: new Date() } },
        { timestamps: false, overwriteImmutable: true },
      );

      const gone = await service.purge(
        (await assets().findById(row.id).exec())!,
      );

      expect(gone).toBe(false);
      expect(deleteMedia).toHaveBeenCalled();
      expect(await assets().countDocuments()).toBe(1);
    });

    it('keeps the row for a retry when deletion fails', async () => {
      const row = await addMedia({ discardedAt: old, createdAt: old });
      deleteMedia.mockRejectedValue(new Error('Cloudinary down'));

      await service.purge(row);

      expect(await assets().countDocuments()).toBe(1);
    });

    it('deletes a file that finished uploading after the discard', async () => {
      await addMedia({
        postId,
        discardedAt: old,
        createdAt: old,
        status: MediaStatus.READY,
      });

      await service.handleNotification(uploaded(42));

      expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
      expect(await assets().countDocuments()).toBe(0);
      expect((await post())?.status).toBe(PostStatus.PROCESSING);
    });
  });
});
