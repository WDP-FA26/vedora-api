import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  MediaType,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaMaintenanceService } from './media-maintenance.service';
import { CaptionService } from './caption.service';
import { MediaService } from './media.service';

const ownerless: MediaAsset = {
  id: '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11',
  ownerId: null,
  type: MediaType.VIDEO,
  status: MediaStatus.READY,
  failureReason: null,
  postId: null,
  position: 0,
  publicId: 'vedora/videos/0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11',
  durationSec: 42,
  aspectRatio: '16:9',
  captionStatus: CaptionStatus.NONE,
  captionLanguage: null,
  discardedAt: new Date('2026-09-25T00:00:00.000Z'),
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

describe('MediaMaintenanceService', () => {
  let maintenance: MediaMaintenanceService;
  let prisma: DeepMockProxy<PrismaService>;
  let mediaService: DeepMockProxy<MediaService>;
  let captions: DeepMockProxy<CaptionService>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    mediaService = mockDeep<MediaService>();
    captions = mockDeep<CaptionService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaMaintenanceService,
        CloudinaryService,
        { provide: PrismaService, useValue: prisma },
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
    maintenance = moduleRef.get(MediaMaintenanceService);
  });

  it('discards media of deleted accounts and purges it from Cloudinary', async () => {
    prisma.mediaAsset.findMany.mockResolvedValue([ownerless]);

    await maintenance.purgeDiscarded();

    const [sweep] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(sweep.where).toEqual({ ownerId: null, discardedAt: null });
    expect(sweep.data.discardedAt).toBeInstanceOf(Date);
    expect(mediaService.purge).toHaveBeenCalledWith(ownerless);
  });

  it('releases captioning cut off by a restart and resumes it', async () => {
    await maintenance.advanceCaptions();

    expect(captions.releaseStale).toHaveBeenCalled();
    expect(captions.schedule).toHaveBeenCalled();
  });
});
