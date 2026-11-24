import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createMedia, createPost, createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';
import { CloudinaryService } from '@src/cloudinary/cloudinary.service.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  type MediaAsset,
  MediaStatus,
  type Post,
  PostStatus,
} from '@src/mongo/models.js';
import { CaptionService } from '@src/media/captions/caption.service.js';
import { MediaMaintenanceService } from '@src/media/media-maintenance.service.js';
import { MediaService } from '@src/media/media.service.js';

describe('MediaMaintenanceService', () => {
  let app: INestApplication;
  let db: MongoService;
  let cloudinary: CloudinaryService;
  let maintenance: MediaMaintenanceService;
  let mediaService: {
    purge: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    settlePosts: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  };
  let captions: {
    releaseStale: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
    backfillTranscripts: ReturnType<typeof vi.fn>;
  };

  const assets = () => db.connection.model<MediaAsset>('MediaAsset');
  const posts = () => db.connection.model<Post>('Post');
  const reload = (id: string) => assets().findById(id).exec();

  beforeAll(async () => {
    mediaService = {
      purge: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(undefined),
      settlePosts: vi.fn().mockResolvedValue(undefined),
      discard: vi.fn().mockResolvedValue(undefined),
    };
    captions = {
      releaseStale: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn(),
      backfillTranscripts: vi.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('mediamaint'))],
      providers: [
        MediaMaintenanceService,
        CloudinaryService,
        { provide: MediaService, useValue: mediaService },
        { provide: CaptionService, useValue: captions },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CLOUDINARY_CLOUD_NAME: 'demo',
            CLOUDINARY_API_KEY: 'key',
            CLOUDINARY_API_SECRET: 'secret',
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    cloudinary = app.get(CloudinaryService);
    maintenance = app.get(MediaMaintenanceService);
  });
  beforeEach(async () => {
    await db.connection.collections.media_assets.deleteMany({});
    await posts().deleteMany({});
    vi.restoreAllMocks();
    mediaService.purge.mockClear();
    mediaService.refresh.mockClear();
    mediaService.settlePosts.mockClear();
    mediaService.discard.mockClear();
    captions.releaseStale.mockClear();
    captions.schedule.mockClear();
    captions.backfillTranscripts.mockClear();
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('discards media of deleted accounts and purges it from Cloudinary', async () => {
    const ownerless = await createMedia(db, {
      ownerId: null,
      status: MediaStatus.READY,
    });

    await maintenance.purgeDiscarded();

    const stored = await reload(ownerless.id);
    expect(stored?.discardedAt).toBeInstanceOf(Date);
    expect(mediaService.purge).toHaveBeenCalledWith(
      expect.objectContaining({ id: ownerless.id }),
    );
  });

  it('leaves media with an owner alone and skips purge when Cloudinary is unconfigured', async () => {
    const owned = await createMedia(db, { ownerId: 'someone' });
    await maintenance.purgeDiscarded();
    const stored = await reload(owned.id);
    expect(stored?.discardedAt).toBeNull();
    expect(mediaService.purge).not.toHaveBeenCalled();

    vi.spyOn(cloudinary, 'configured', 'get').mockReturnValueOnce(false);
    await maintenance.purgeDiscarded();
    expect(mediaService.purge).not.toHaveBeenCalled();
  });

  it('releases captioning cut off by a restart and resumes it', async () => {
    await maintenance.advanceCaptions();

    expect(captions.releaseStale).toHaveBeenCalled();
    expect(captions.schedule).toHaveBeenCalled();
  });

  it('delegates transcript backfilling to CaptionService', async () => {
    await maintenance.backfillTranscripts();
    expect(captions.backfillTranscripts).toHaveBeenCalledOnce();
  });

  it('refreshes stale pending media and skips fresh, ready, or unconfigured runs', async () => {
    const staleWaiting = await createMedia(db, {
      ownerId: 'u1',
      status: MediaStatus.WAITING_UPLOAD,
    });
    const staleReady = await createMedia(db, {
      ownerId: 'u1',
      status: MediaStatus.READY,
    });
    const freshWaiting = await createMedia(db, {
      ownerId: 'u1',
      status: MediaStatus.WAITING_UPLOAD,
    });

    const oldDate = new Date(Date.now() - 15 * 60 * 1000);
    await assets().updateMany(
      { _id: { $in: [staleWaiting.id, staleReady.id] } },
      { $set: { updatedAt: oldDate } },
      { timestamps: false },
    );

    vi.spyOn(cloudinary, 'configured', 'get').mockReturnValueOnce(false);
    await maintenance.refreshStale();
    expect(mediaService.refresh).not.toHaveBeenCalled();

    await maintenance.refreshStale();
    expect(mediaService.refresh).toHaveBeenCalledTimes(1);
    expect(mediaService.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: staleWaiting.id }),
    );
    expect(freshWaiting.id).toBeTruthy();
  });

  it('retries moderation for stale PROCESSING posts and skips when none are stale', async () => {
    await maintenance.retryModeration();
    expect(mediaService.settlePosts).not.toHaveBeenCalled();

    const author = await createUser(db);
    const stalePost = await createPost(db, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      publishedAt: null,
    });
    const freshPost = await createPost(db, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      publishedAt: null,
    });
    await posts().updateOne(
      { _id: stalePost.id },
      { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) } },
      { timestamps: false },
    );

    await maintenance.retryModeration();

    expect(mediaService.settlePosts).toHaveBeenCalledWith([stalePost.id]);
    expect(freshPost.id).toBeTruthy();
  });

  it('discards unattached uploads older than 24h and ignores recent or attached ones', async () => {
    await maintenance.deleteOrphans();
    expect(mediaService.discard).not.toHaveBeenCalled();

    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const orphan = await createMedia(db, { ownerId: 'u1', postId: null });
    const attached = await createMedia(db, {
      ownerId: 'u1',
      postId: 'post-1',
    });
    const recent = await createMedia(db, { ownerId: 'u1', postId: null });

    await assets().updateMany(
      { _id: { $in: [orphan.id, attached.id] } },
      { $set: { createdAt: oldDate } },
      { timestamps: false, overwriteImmutable: true },
    );

    await maintenance.deleteOrphans();

    expect(mediaService.discard).toHaveBeenCalledWith({
      _id: { $in: [orphan.id] },
      postId: null,
    });
    expect(recent.id).toBeTruthy();
  });
});
