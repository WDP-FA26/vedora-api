import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CaptionStatus, MediaAsset, MediaStatus, MediaType } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MuxService } from '../mux/mux.service';
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
  muxUploadId: 'upload-1',
  muxAssetId: 'asset-1',
  playbackId: 'playback-1',
  durationSec: 42,
  aspectRatio: '16:9',
  captionStatus: CaptionStatus.NONE,
  captionLanguage: null,
  captionTrackId: null,
  captionJobId: null,
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
        MuxService,
        { provide: PrismaService, useValue: prisma },
        { provide: MediaService, useValue: mediaService },
        { provide: CaptionService, useValue: captions },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MUX_TOKEN_ID: 'id',
            MUX_TOKEN_SECRET: 'secret',
          }),
        },
      ],
    }).compile();
    maintenance = moduleRef.get(MediaMaintenanceService);
  });

  it('discards media of deleted accounts and purges it from Mux', async () => {
    prisma.mediaAsset.findMany.mockResolvedValue([ownerless]);

    await maintenance.purgeDiscarded();

    const [sweep] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(sweep.where).toEqual({ ownerId: null, discardedAt: null });
    expect(sweep.data.discardedAt).toBeInstanceOf(Date);
    expect(mediaService.purge).toHaveBeenCalledWith(ownerless);
  });

  it('retries captions whose webhook never arrived', async () => {
    const waiting = { ...ownerless, captionStatus: CaptionStatus.GENERATING };
    captions.findInFlight.mockResolvedValue([waiting]);

    await maintenance.advanceCaptions();

    expect(captions.start).toHaveBeenCalledWith();
    const [staleBefore] = captions.findInFlight.mock.calls[0];
    expect(staleBefore.getTime()).toBeLessThan(Date.now() - 9 * 60 * 1000);
    expect(captions.advance).toHaveBeenCalledWith(waiting);
  });
});
