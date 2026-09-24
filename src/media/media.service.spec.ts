import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type Mux from '@mux/ts';
import type {
  BaseWebhookEvent,
  VideoAssetReadyWebhookEvent,
  VideoUploadAssetCreatedWebhookEvent,
} from '@mux/ts/resources/webhooks/webhooks';
import {
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  PostStatus,
} from '@prisma/client';
import { mockDeep } from 'jest-mock-extended';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';
import { MuxWebhookController } from './mux-webhook.controller';

const mediaId = '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11';

const pendingMedia: MediaAsset = {
  id: mediaId,
  ownerId: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  type: MediaType.VIDEO,
  status: MediaStatus.PROCESSING,
  failureReason: null,
  postId: null,
  position: 0,
  muxUploadId: 'upload-1',
  muxAssetId: 'asset-1',
  playbackId: null,
  durationSec: null,
  aspectRatio: null,
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

const eventBase: Omit<BaseWebhookEvent, 'data' | 'type'> = {
  id: 'event-1',
  attempts: [],
  created_at: '2026-09-24T00:00:00.000Z',
  environment: { id: 'env-1', name: 'test' },
  object: { id: 'asset-1', type: 'asset' },
};

function assetReady(duration: number): VideoAssetReadyWebhookEvent {
  return {
    ...eventBase,
    type: 'video.asset.ready',
    data: {
      id: 'asset-1',
      created_at: 0,
      encoding_tier: 'baseline',
      master_access: 'none',
      max_resolution_tier: '1080p',
      progress: { progress: 100, state: 'completed' },
      status: 'ready',
      passthrough: mediaId,
      duration,
      aspect_ratio: '9:16',
      playback_ids: [{ id: 'playback-1', policy: 'public' }],
    },
  };
}

function uploadAssetCreated(): VideoUploadAssetCreatedWebhookEvent {
  return {
    ...eventBase,
    type: 'video.upload.asset_created',
    data: {
      id: 'upload-1',
      cors_origin: 'http://localhost:3000',
      status: 'asset_created',
      timeout: 3600,
      asset_id: 'asset-1',
    },
  };
}

describe('MediaService', () => {
  const prisma = mockDeep<PrismaService>();
  const muxClient = mockDeep<Mux>();
  const mux = new MuxService(
    new ConfigService({ MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' }),
  );
  const service = new MediaService(
    prisma,
    mux,
    new ConfigService({ MAX_VIDEO_DURATION_SEC: 180 }),
  );

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(mux, 'require').mockReturnValue(muxClient);
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

  it('moves an uploaded file to PROCESSING when Mux creates its asset', async () => {
    await service.handleWebhook(uploadAssetCreated());

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { muxUploadId: 'upload-1', status: MediaStatus.WAITING_UPLOAD },
      data: { status: MediaStatus.PROCESSING, muxAssetId: 'asset-1' },
    });
  });
});

describe('MuxWebhookController', () => {
  const secret = 'test-webhook-secret';
  const mediaService = mockDeep<MediaService>();
  const controller = new MuxWebhookController(
    new MuxService(
      new ConfigService({
        MUX_TOKEN_ID: 'id',
        MUX_TOKEN_SECRET: 'secret',
        MUX_WEBHOOK_SECRET: secret,
      }),
    ),
    mediaService,
  );

  const body = JSON.stringify(assetReady(42));

  function sign(payload: string, key = secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', key)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return { 'mux-signature': `t=${timestamp},v1=${digest}` };
  }

  beforeEach(() => jest.resetAllMocks());

  it('passes correctly signed events to MediaService', async () => {
    await controller.receive(Buffer.from(body), sign(body));

    const [event] = mediaService.handleWebhook.mock.calls[0];
    expect(event.type).toBe('video.asset.ready');
  });

  it('rejects events signed with another secret', async () => {
    await expect(
      controller.receive(Buffer.from(body), sign(body, 'wrong-secret')),
    ).rejects.toMatchObject({ status: 400 });
    expect(mediaService.handleWebhook).not.toHaveBeenCalled();
  });
});
