import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createMedia } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import { type MediaAsset, MediaStatus } from '../mongo/models';
import { CaptionService } from './caption.service';
import { MediaMaintenanceService } from './media-maintenance.service';
import { MediaService } from './media.service';

describe('MediaMaintenanceService', () => {
  let app: INestApplication;
  let db: MongoService;
  let maintenance: MediaMaintenanceService;
  let mediaService: { purge: ReturnType<typeof vi.fn> };
  let captions: {
    releaseStale: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
  };

  const assets = () => db.connection.model<MediaAsset>('MediaAsset');
  const reload = (id: string) => assets().findById(id).exec();

  beforeAll(async () => {
    mediaService = { purge: vi.fn().mockResolvedValue(true) };
    captions = {
      releaseStale: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn(),
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
    maintenance = app.get(MediaMaintenanceService);
  });
  beforeEach(async () => {
    await db.db.collection('media_assets').deleteMany({});
    mediaService.purge.mockClear();
    captions.releaseStale.mockClear();
    captions.schedule.mockClear();
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

  it('leaves media with an owner alone', async () => {
    const owned = await createMedia(db, { ownerId: 'someone' });
    await maintenance.purgeDiscarded();
    const stored = await reload(owned.id);
    expect(stored?.discardedAt).toBeNull();
    expect(mediaService.purge).not.toHaveBeenCalled();
  });

  it('releases captioning cut off by a restart and resumes it', async () => {
    await maintenance.advanceCaptions();

    expect(captions.releaseStale).toHaveBeenCalled();
    expect(captions.schedule).toHaveBeenCalled();
  });
});
