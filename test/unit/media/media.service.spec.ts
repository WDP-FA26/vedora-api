import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ClientSession } from 'mongoose';
import type { MockInstance } from 'vitest';
import { createMedia, createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';
import { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import {
  CaptionStatus,
  type MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  type Post,
  PostStatus,
} from '../../../src/mongo/models.js';
import { CaptionService } from '../../../src/media/captions/caption.service.js';
import {
  mediaId,
  ownerId,
  publicId,
  streamBuilt,
  uploaded,
} from '../../support/media.fixtures.js';
import { MediaService } from '../../../src/media/media.service.js';
import { PostModerationService } from '../../../src/media/post-moderation.service.js';
import { ContentModerationService } from '../../../src/moderation/content-moderation.service.js';
import type { EvidenceSources } from '../../../src/moderation/content-evidence.js';
import { StorageService } from '../../../src/storage/storage.service.js';
import { Subject } from 'rxjs';
import { NotificationsService } from '../../../src/notifications/notifications.service.js';

vi.mock('../../../src/common/http/fetch-public-image.js', () => ({
  fetchPublicImage: vi.fn(() => Promise.resolve(Buffer.from('frame'))),
}));

function assessment(
  decision: 'publish' | 'review' | 'reject',
  category: string | null,
  riskLevel: number,
) {
  return { decision, category, riskLevel, evidence: null };
}

describe('MediaService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: MediaService;
  let cloudinary: CloudinaryService;
  let findVideo: MockInstance<CloudinaryService['findVideo']>;
  let deleteMedia: MockInstance<CloudinaryService['deleteMedia']>;
  let schedule: ReturnType<typeof vi.fn>;
  let review: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let active: boolean;
  const transcribed = new Subject<string>();
  let postId: string;

  const assets = () => db.connection.model<MediaAsset>('MediaAsset');
  const posts = () => db.connection.model<Post>('Post');
  const media = () => assets().findById(mediaId).exec();
  const post = () => posts().findById(postId).exec();
  const addMedia = (fields: Partial<MediaAsset> = {}) =>
    createMedia(db, { id: mediaId, publicId, ownerId, ...fields });
  const claim = (ids: string[]) =>
    db.withTransaction((session: ClientSession) =>
      service.claimForPost(session, ownerId, postId, ids),
    );

  beforeAll(async () => {
    schedule = vi.fn();
    review = vi.fn();
    notify = vi.fn();
    active = false;
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('mediaservice'))],
      providers: [
        MediaService,
        CloudinaryService,
        PostModerationService,
        {
          provide: ContentModerationService,
          useValue: { review, modelId: 'anthropic/claude-haiku-5.5' },
        },
        { provide: StorageService, useValue: {} },
        { provide: NotificationsService, useValue: { notify } },
        {
          provide: CaptionService,
          useValue: {
            schedule,
            transcribed,
            get active() {
              return active;
            },
          },
        },
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
    cloudinary = app.get(CloudinaryService);
    findVideo = vi.spyOn(cloudinary, 'findVideo').mockResolvedValue(null);
    deleteMedia = vi.spyOn(cloudinary, 'deleteMedia').mockResolvedValue();
    await createUser(db, { id: ownerId });
  });
  beforeEach(async () => {
    await assets().deleteMany({});
    await posts().deleteMany({});
    schedule.mockClear();
    active = false;
    review.mockReset();
    notify.mockReset();
    review.mockResolvedValue(assessment('publish', null, 0));
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
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        recipientId: ownerId,
        type: 'POST_PUBLISHED',
        postId,
      }),
    );
  });

  describe('settling in the background', () => {
    it('moderates the posts after returning, and whenSettled waits for the verdict', async () => {
      service.settlePostsLater([postId]);
      expect((await post())?.status).toBe(PostStatus.PROCESSING);

      await service.whenSettled();

      expect(await post()).toMatchObject({
        status: PostStatus.PUBLISHED,
        publishedAt: expect.any(Date) as Date,
      });
      expect(review).toHaveBeenCalledOnce();
    });

    it('does not resolve whenSettled before a slow run has ended', async () => {
      let finish: () => void = () => undefined;
      const settlePosts = vi.spyOn(service, 'settlePosts').mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      let settled = false;

      service.settlePostsLater([postId]);
      const waiting = service.whenSettled().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      finish();
      await waiting;
      expect(settled).toBe(true);
      expect(settlePosts).toHaveBeenCalledWith([postId]);
      settlePosts.mockRestore();
    });

    it('logs a failing run instead of throwing it', async () => {
      const settlePosts = vi
        .spyOn(service, 'settlePosts')
        .mockRejectedValueOnce(new Error('db down'));
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      expect(() => service.settlePostsLater([postId])).not.toThrow();
      await expect(service.whenSettled()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Moderating posts ${postId} failed`),
      );
      settlePosts.mockRestore();
      warn.mockRestore();
    });
  });

  it('judges the text and four frames of a video before publishing', async () => {
    await addMedia({ postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    const sources = review.mock.calls[0]?.[0] as EvidenceSources;
    expect(sources.images).toHaveLength(4);
    expect(sources.images.every(({ field }) => field === 'frame')).toBe(true);
  });

  describe('when videos are transcribed first', () => {
    beforeEach(() => {
      active = true;
    });

    it('waits for the transcript, then judges it with the frames and publishes', async () => {
      await addMedia({ postId, status: MediaStatus.PROCESSING });

      await service.handleNotification(streamBuilt());
      expect(review).not.toHaveBeenCalled();
      expect((await post())?.status).toBe(PostStatus.PROCESSING);
      expect(schedule).toHaveBeenCalled();

      await assets().updateOne(
        { _id: mediaId },
        {
          $set: {
            transcript: 'Hôm nay mình nấu canh chua',
            captionStatus: CaptionStatus.TRANSCRIBING,
          },
        },
      );
      transcribed.next(postId);
      await vi.waitFor(async () => {
        expect((await post())?.status).toBe(PostStatus.PUBLISHED);
      });

      const sources = review.mock.calls[0]?.[0] as EvidenceSources;
      expect(sources.images).toHaveLength(4);
      expect(sources.texts).toContainEqual({
        field: 'transcript',
        mediaId,
        text: 'Hôm nay mình nấu canh chua',
      });
    });

    it('blocks a post whose transcript breaks the policy', async () => {
      review.mockResolvedValue(assessment('reject', 'violence', 3));
      await addMedia({ postId, status: MediaStatus.PROCESSING });
      await service.handleNotification(streamBuilt());

      await assets().updateOne(
        { _id: mediaId },
        { $set: { transcript: 'một lời đe dọa' } },
      );
      transcribed.next(postId);
      await vi.waitFor(async () => {
        expect((await post())?.status).toBe(PostStatus.REJECTED);
      });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'POST_REJECTED', reason: 'violence' }),
      );
    });

    it('goes on with the frames when there is nothing to transcribe', async () => {
      await addMedia({
        postId,
        status: MediaStatus.PROCESSING,
        captionStatus: CaptionStatus.NO_SPEECH,
      });

      await service.handleNotification(streamBuilt());

      expect((await post())?.status).toBe(PostStatus.PUBLISHED);
      const sources = review.mock.calls[0]?.[0] as EvidenceSources;
      expect(sources.images.length).toBeGreaterThan(0);
    });
  });

  it('rejects the post and keeps it hidden when moderation blocks it', async () => {
    review.mockResolvedValue(assessment('reject', 'violence', 3));
    await addMedia({ postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    expect(await post()).toMatchObject({
      status: PostStatus.REJECTED,
      moderation: { verdict: 'violence' },
    });
    expect(notify).toHaveBeenCalledWith({
      recipientId: ownerId,
      type: 'POST_REJECTED',
      postId,
      reason: 'violence',
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('holds the post for an admin when moderation is unsure', async () => {
    review.mockResolvedValue(assessment('review', 'hate', 2));
    await addMedia({ postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    expect(await post()).toMatchObject({
      status: PostStatus.PENDING_REVIEW,
      moderation: { verdict: 'hate', riskLevel: 2 },
    });
    expect(notify).toHaveBeenCalledWith({
      recipientId: ownerId,
      type: 'POST_PENDING_REVIEW',
      postId,
      reason: 'hate',
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('holds the post for an admin when the model cannot answer', async () => {
    review.mockRejectedValueOnce(new Error('timeout'));
    await addMedia({ postId, status: MediaStatus.PROCESSING });

    await service.handleNotification(streamBuilt());

    expect(await post()).toMatchObject({
      status: PostStatus.PENDING_REVIEW,
      moderation: {
        verdict: 'moderation_failed',
        riskLevel: null,
        evidence: { status: 'FAILED' },
      },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'POST_PENDING_REVIEW',
        reason: 'moderation_failed',
      }),
    );
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

  describe('findOwned and toResponse', () => {
    it('throws 404 when media is missing, owned by someone else, or discarded', async () => {
      await addMedia({ ownerId: 'other-user' });
      await expect(service.findOwned(mediaId, ownerId)).rejects.toMatchObject({
        statusCode: 404,
      });

      await assets().updateOne(
        { _id: mediaId },
        { $set: { ownerId, discardedAt: new Date() } },
      );
      await expect(service.findOwned(mediaId, ownerId)).rejects.toMatchObject({
        statusCode: 404,
      });

      await expect(
        service.findOwned('non-existent', ownerId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refreshes pending media on findOwned when webhooks are disabled', async () => {
      await addMedia({ postId, status: MediaStatus.PROCESSING });
      findVideo.mockResolvedValue({
        public_id: publicId,
        duration: 15,
        derived: [{ transformation: 'sp_auto/m3u8', format: 'm3u8' }],
      });

      const dto = await service.findOwned(mediaId, ownerId);

      expect(findVideo).toHaveBeenCalledWith(publicId);
      expect(dto.status).toBe(MediaStatus.READY);
      expect(dto.playbackUrl).toBe(
        `https://res.cloudinary.com/demo/video/upload/sp_auto/${publicId}.m3u8`,
      );
      expect(dto.posterUrl).toBe(
        `https://res.cloudinary.com/demo/video/upload/so_0,q_auto/${publicId}.jpg`,
      );
    });

    it('skips refresh on findOwned when webhooks are enabled or media is already READY', async () => {
      await addMedia({
        status: MediaStatus.READY,
        captions: [
          {
            languageCode: 'en',
            name: 'English',
            isOriginal: false,
            url: 'https://cdn/en.vtt',
          },
          {
            languageCode: 'vi',
            name: 'Tiếng Việt',
            isOriginal: true,
            url: 'https://cdn/vi.vtt',
          },
        ],
      });

      const readyDto = await service.findOwned(mediaId, ownerId);
      expect(findVideo).not.toHaveBeenCalled();
      expect(readyDto.captions.map((c) => c.languageCode)).toEqual([
        'vi',
        'en',
      ]);

      const pending = await createMedia(db, {
        ownerId,
        status: MediaStatus.PROCESSING,
      });
      Object.defineProperty(cloudinary, 'webhooksEnabled', {
        value: true,
        configurable: true,
      });
      try {
        const pendingDto = await service.findOwned(pending.id, ownerId);
        expect(findVideo).not.toHaveBeenCalled();
        expect(pendingDto.playbackUrl).toBeNull();
        expect(pendingDto.posterUrl).toBeNull();
      } finally {
        Object.defineProperty(cloudinary, 'webhooksEnabled', {
          value: false,
          configurable: true,
        });
      }
    });
  });

  describe('removeOwned and discard edge cases', () => {
    it('throws 404 when removing missing or unowned media', async () => {
      await addMedia({ ownerId: 'someone-else' });
      await expect(service.removeOwned(mediaId, ownerId)).rejects.toMatchObject(
        { statusCode: 404 },
      );
    });

    it('does nothing when discard filter matches no live media', async () => {
      await expect(service.discard({ _id: 'none' })).resolves.toBeUndefined();
      expect(deleteMedia).not.toHaveBeenCalled();
    });
  });

  describe('replacePostMedia', () => {
    const replace = (ids: string[]) =>
      db.withTransaction((session: ClientSession) =>
        service.replacePostMedia(session, ownerId, postId, ids),
      );

    it('returns changed: false when attached media order is unchanged', async () => {
      const first = await createMedia(db, { ownerId, postId, position: 0 });
      const second = await createMedia(db, { ownerId, postId, position: 1 });

      const result = await replace([first.id, second.id]);

      expect(result).toEqual({ changed: false, detachedIds: [] });
    });

    it('rejects keeping an attached media that failed processing', async () => {
      const failed = await createMedia(db, {
        ownerId,
        postId,
        status: MediaStatus.FAILED,
      });

      await expect(replace([failed.id])).rejects.toMatchObject({
        code: 'MEDIA_UNAVAILABLE',
      });
    });

    it('detaches removed media, reorders kept media, and claims new uploads', async () => {
      const kept = await createMedia(db, { ownerId, postId, position: 0 });
      const removed = await createMedia(db, { ownerId, postId, position: 1 });
      const added = await createMedia(db, { ownerId, postId: null });

      const result = await replace([added.id, kept.id]);

      expect(result).toEqual({ changed: true, detachedIds: [removed.id] });
      expect((await assets().findById(removed.id).exec())?.postId).toBeNull();
      expect((await assets().findById(added.id).exec())?.position).toBe(0);
      expect((await assets().findById(kept.id).exec())?.position).toBe(1);
    });
  });

  describe('notification and refresh edge cases', () => {
    it('ignores non-video, missing public_id, and unknown notification types', async () => {
      await addMedia();

      await service.handleNotification({
        notification_type: 'upload',
        resource_type: 'image',
        public_id: publicId,
      });
      await service.handleNotification({
        notification_type: 'upload',
        resource_type: 'video',
      });
      await service.handleNotification({
        notification_type: 'delete',
        resource_type: 'video',
        public_id: publicId,
      });

      expect((await media())?.status).toBe(MediaStatus.WAITING_UPLOAD);
    });

    it('marks media ENCODING_FAILED when eager item carries an error', async () => {
      await addMedia({ postId, status: MediaStatus.PROCESSING });

      await service.handleNotification({
        ...streamBuilt(),
        eager: [{ error: 'corrupt stream' }],
      });

      expect(await media()).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.ENCODING_FAILED,
      });
    });

    it('falls back to video.dar or null for aspectRatio and ignores duplicate upload notification', async () => {
      await addMedia({ status: MediaStatus.WAITING_UPLOAD });

      await service.handleNotification({
        notification_type: 'upload',
        resource_type: 'video',
        public_id: publicId,
        duration: 12,
        video: { dar: '16:9' },
      });
      expect((await media())?.aspectRatio).toBe('16:9');

      // Second upload notification while PROCESSING is a no-op
      await service.handleNotification({
        notification_type: 'upload',
        resource_type: 'video',
        public_id: publicId,
        duration: 999,
      });
      expect((await media())?.durationSec).toBe(12);

      const second = await createMedia(db, { ownerId });
      await service.handleNotification({
        notification_type: 'upload',
        resource_type: 'video',
        public_id: second.publicId,
        video: { dar: 'invalid' },
      });
      expect(
        (await assets().findById(second.id).exec())?.aspectRatio,
      ).toBeNull();
    });

    it('does nothing on streamBuilt for WAITING_UPLOAD when findVideo returns null', async () => {
      await addMedia({ status: MediaStatus.WAITING_UPLOAD });
      findVideo.mockResolvedValue(null);

      await service.handleNotification(streamBuilt());

      expect((await media())?.status).toBe(MediaStatus.WAITING_UPLOAD);
    });

    it('marks PROCESSING media UPLOAD_ERRORED if missing in Cloudinary and ENCODING_FAILED if timed out', async () => {
      const missing = await addMedia({
        postId,
        status: MediaStatus.PROCESSING,
      });
      findVideo.mockResolvedValueOnce(null);

      await service.refresh(missing);
      expect(await media()).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.UPLOAD_ERRORED,
      });

      const timedOut = await createMedia(db, {
        ownerId,
        postId,
        status: MediaStatus.PROCESSING,
      });
      await assets().updateOne(
        { _id: timedOut.id },
        { $set: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
        { timestamps: false },
      );
      findVideo.mockResolvedValueOnce({
        public_id: timedOut.publicId,
        duration: 20,
        derived: [],
      });

      await service.refresh((await assets().findById(timedOut.id).exec())!);
      expect(await assets().findById(timedOut.id).exec()).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.ENCODING_FAILED,
      });
    });

    it('swallows findVideo errors during refresh and skips non-pending or unconfigured refresh', async () => {
      const ready = await addMedia({ status: MediaStatus.READY });
      await service.refresh(ready);
      expect(findVideo).not.toHaveBeenCalled();

      const pending = await createMedia(db, {
        ownerId,
        status: MediaStatus.WAITING_UPLOAD,
      });
      findVideo.mockRejectedValueOnce(new Error('rate limit'));
      await expect(service.refresh(pending)).resolves.toBeUndefined();

      vi.spyOn(cloudinary, 'configured', 'get').mockReturnValueOnce(false);
      await expect(
        service.deleteFromCloudinary({
          id: mediaId,
          captionStatus: CaptionStatus.NONE,
        }),
      ).resolves.toBe(true);
    });
  });
});
