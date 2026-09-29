import type {
  BaseWebhookEvent,
  VideoAssetReadyWebhookEvent,
  VideoUploadAssetCreatedWebhookEvent,
} from '@mux/ts/resources/webhooks/webhooks';
import { CaptionStatus, MediaAsset, MediaStatus, MediaType } from '@prisma/client';

// Test fixtures shared by the media specs.

export const mediaId = '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11';
export const ownerId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';

export const pendingMedia: MediaAsset = {
  id: mediaId,
  ownerId,
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
  captionStatus: CaptionStatus.NONE,
  captionLanguage: null,
  captionTrackId: null,
  captionJobId: null,
  discardedAt: null,
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

export const eventBase: Omit<BaseWebhookEvent, 'data' | 'type'> = {
  id: 'event-1',
  attempts: [],
  created_at: '2026-09-24T00:00:00.000Z',
  environment: { id: 'env-1', name: 'test' },
  object: { id: 'asset-1', type: 'asset' },
};

export function assetReady(duration: number): VideoAssetReadyWebhookEvent {
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

export function uploadAssetCreated(): VideoUploadAssetCreatedWebhookEvent {
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
