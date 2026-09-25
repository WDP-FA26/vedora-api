import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type Mux from '@mux/ts';
import {
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  PostStatus,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';

import {
  assetReady,
  eventBase,
  mediaId,
  ownerId,
  pendingMedia,
  uploadAssetCreated,
} from './media.fixtures';

describe('MediaService', () => {
  let service: MediaService;
  let prisma: DeepMockProxy<PrismaService>;
  let muxClient: DeepMockProxy<Mux>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    muxClient = mockDeep<Mux>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaService,
        MuxService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MUX_TOKEN_ID: 'id',
            MUX_TOKEN_SECRET: 'secret',
            MAX_VIDEO_DURATION_SEC: 180,
          }),
        },
      ],
    }).compile();
    service = moduleRef.get(MediaService);
    // The real MuxService reads config; only its SDK client is mocked.
    vi.spyOn(moduleRef.get(MuxService), 'require').mockReturnValue(muxClient);

    prisma.mediaAsset.findFirst.mockResolvedValue(pendingMedia);
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 1 });
    prisma.post.updateMany.mockResolvedValue({ count: 1 });
  });

  it('marks media READY and publishes its post when the asset is ready', async () => {
    await service.handleWebhook(assetReady(42));

    expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith({
      where: { id: mediaId },
    });
    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toMatchObject({
      status: MediaStatus.READY,
      playbackId: 'playback-1',
      durationSec: 42,
      aspectRatio: '9:16',
    });
    const [publish] = prisma.post.updateMany.mock.calls[1];
    expect(publish.data).toMatchObject({ status: PostStatus.PUBLISHED });
  });

  it('ignores a replayed ready event for media that is already READY', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue({
      ...pendingMedia,
      status: MediaStatus.READY,
    });

    await service.handleWebhook(assetReady(42));

    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('fails videos over the duration limit and deletes them from Mux', async () => {
    await service.handleWebhook(assetReady(181));

    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toEqual({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.TOO_LONG,
    });
    const [fail] = prisma.post.updateMany.mock.calls[0];
    expect(fail.data).toEqual({ status: PostStatus.FAILED });
    expect(muxClient.video.assets.delete).toHaveBeenCalledWith('asset-1');
  });

  it('deletes the Mux asset of a video that failed to encode', async () => {
    await service.handleWebhook({
      ...eventBase,
      type: 'video.asset.errored',
      data: {
        id: 'asset-1',
        created_at: 0,
        encoding_tier: 'baseline',
        master_access: 'none',
        max_resolution_tier: '1080p',
        progress: { progress: 0, state: 'errored' },
        status: 'errored',
        passthrough: mediaId,
      },
    });

    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toEqual({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.ENCODING_FAILED,
    });
    expect(muxClient.video.assets.delete).toHaveBeenCalledWith('asset-1');
    expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
  });

  it('moves an uploaded file to PROCESSING when Mux creates its asset', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue(null);

    await service.handleWebhook(uploadAssetCreated());

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: {
        discardedAt: null,
        muxUploadId: 'upload-1',
        status: MediaStatus.WAITING_UPLOAD,
      },
      data: { status: MediaStatus.PROCESSING, muxAssetId: 'asset-1' },
    });
  });

  describe('discarding', () => {
    const discarded: MediaAsset = {
      ...pendingMedia,
      muxAssetId: null,
      discardedAt: new Date('2026-09-25T00:00:00.000Z'),
    };

    it('hides the upload, deletes its Mux asset, then drops the row', async () => {
      prisma.mediaAsset.findMany.mockResolvedValue([pendingMedia]);

      await service.removeOwned(mediaId, ownerId);

      const [mark] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(mark.data.discardedAt).toBeInstanceOf(Date);
      expect(muxClient.video.assets.delete).toHaveBeenCalledWith('asset-1');
      expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: mediaId, discardedAt: { not: null } },
      });
    });

    it('cancels an upload that is still waiting for its file', async () => {
      muxClient.video.uploads.retrieve.mockResolvedValue({
        id: 'upload-1',
        cors_origin: 'http://localhost:3000',
        status: 'waiting',
        timeout: 3600,
      });

      await service.purge(discarded);

      expect(muxClient.video.uploads.cancel).toHaveBeenCalledWith('upload-1');
      expect(prisma.mediaAsset.deleteMany).toHaveBeenCalled();
    });

    it('keeps the row for a retry when Mux deletion fails', async () => {
      muxClient.video.assets.delete.mockRejectedValue(new Error('Mux down'));

      await service.purge({ ...discarded, muxAssetId: 'asset-1' });

      expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes an asset Mux created after the upload was discarded', async () => {
      prisma.mediaAsset.findFirst.mockResolvedValue(discarded);

      await service.handleWebhook(uploadAssetCreated());

      expect(muxClient.video.assets.delete).toHaveBeenCalledWith('asset-1');
      expect(prisma.mediaAsset.deleteMany).toHaveBeenCalled();
      expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    });

    it('deletes a discarded asset when its ready event arrives', async () => {
      prisma.mediaAsset.findFirst.mockResolvedValue(discarded);

      await service.handleWebhook(assetReady(42));

      expect(muxClient.video.assets.delete).toHaveBeenCalledWith('asset-1');
      expect(prisma.post.updateMany).not.toHaveBeenCalled();
    });
  });
});
