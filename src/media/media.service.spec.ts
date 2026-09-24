import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MediaStatus, PostStatus } from '@prisma/client';
import type { MediaAsset } from '@prisma/client';
import type { UnwrapWebhookEvent } from '@mux/ts/resources/webhooks/webhooks';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';
import { MuxWebhookController } from './mux-webhook.controller';

describe('MediaService', () => {
  const mediaId = '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11';
  const pendingMedia = {
    id: mediaId,
    status: MediaStatus.PROCESSING,
    muxUploadId: 'upload-1',
    muxAssetId: 'asset-1',
  } as MediaAsset;

  const findFirst = jest.fn();
  const mediaUpdateMany = jest.fn();
  const postUpdateMany = jest.fn();
  const prisma = {
    mediaAsset: { findFirst, updateMany: mediaUpdateMany },
    post: { updateMany: postUpdateMany },
  } as unknown as PrismaService;
  const assetsDelete = jest.fn();
  const mux = {
    configured: true,
    webhooksEnabled: true,
    require: () => ({ video: { assets: { delete: assetsDelete } } }),
  } as unknown as MuxService;
  const config = new ConfigService({ MAX_VIDEO_DURATION_SEC: 180 });
  const service = new MediaService(prisma, mux, config);

  const readyEvent = (duration: number) =>
    ({
      type: 'video.asset.ready',
      data: {
        id: 'asset-1',
        status: 'ready',
        passthrough: mediaId,
        duration,
        aspect_ratio: '9:16',
        playback_ids: [{ id: 'playback-1', policy: 'public' }],
      },
    }) as unknown as UnwrapWebhookEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue(pendingMedia);
    mediaUpdateMany.mockResolvedValue({ count: 1 });
    postUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('marks media READY and publishes its post when the asset is ready', async () => {
    await service.handleWebhook(readyEvent(42));

    expect(findFirst).toHaveBeenCalledWith({ where: { id: mediaId } });
    expect(mediaUpdateMany).toHaveBeenCalledWith({
      where: {
        id: mediaId,
        status: { in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING] },
      },
      data: expect.objectContaining({
        status: MediaStatus.READY,
        playbackId: 'playback-1',
        durationSec: 42,
        aspectRatio: '9:16',
      }) as unknown,
    });
    expect(postUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PostStatus.PUBLISHED,
        }) as unknown,
      }),
    );
  });

  it('ignores a replayed ready event for media that is already READY', async () => {
    findFirst.mockResolvedValue({ ...pendingMedia, status: MediaStatus.READY });

    await service.handleWebhook(readyEvent(42));

    expect(mediaUpdateMany).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('fails videos over the duration limit and deletes them from Mux', async () => {
    await service.handleWebhook(readyEvent(181));

    expect(mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MediaStatus.FAILED, failureReason: 'TOO_LONG' },
      }),
    );
    expect(postUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PostStatus.FAILED } }),
    );
    expect(assetsDelete).toHaveBeenCalledWith('asset-1');
  });

  it('moves an uploaded file to PROCESSING when Mux creates its asset', async () => {
    await service.handleWebhook({
      type: 'video.upload.asset_created',
      data: { id: 'upload-1', asset_id: 'asset-1' },
    } as unknown as UnwrapWebhookEvent);

    expect(mediaUpdateMany).toHaveBeenCalledWith({
      where: { muxUploadId: 'upload-1', status: MediaStatus.WAITING_UPLOAD },
      data: { status: MediaStatus.PROCESSING, muxAssetId: 'asset-1' },
    });
  });
});

describe('MuxWebhookController', () => {
  const secret = 'test-webhook-secret';
  const handleWebhook = jest.fn();
  const mux = new MuxService(
    new ConfigService({
      MUX_TOKEN_ID: 'id',
      MUX_TOKEN_SECRET: 'secret',
      MUX_WEBHOOK_SECRET: secret,
    }),
  );
  const controller = new MuxWebhookController(mux, {
    handleWebhook,
  } as unknown as MediaService);

  const request = (body: string, signature: string) =>
    ({
      rawBody: Buffer.from(body),
      headers: { 'mux-signature': signature },
    }) as never;

  const sign = (body: string, key = secret) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', key)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return `t=${timestamp},v1=${digest}`;
  };

  const body = JSON.stringify({
    type: 'video.asset.ready',
    id: 'event-1',
    data: { id: 'asset-1' },
  });

  beforeEach(() => handleWebhook.mockReset());

  it('passes correctly signed events to MediaService', async () => {
    await controller.receive(request(body, sign(body)));

    expect(handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'video.asset.ready' }),
    );
  });

  it('rejects events signed with another secret', async () => {
    await expect(
      controller.receive(request(body, sign(body, 'wrong-secret'))),
    ).rejects.toMatchObject({ status: 400 });
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
