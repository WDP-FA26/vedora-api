import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  MediaType,
} from '../mongo/models';
import type { CloudinaryNotification } from './dto/cloudinary-notification';

// Test fixtures shared by the media specs.

export const mediaId = '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11';
export const ownerId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
export const publicId = `vedora/videos/${mediaId}`;

export const pendingMedia: MediaAsset = {
  _id: mediaId,
  id: mediaId,
  ownerId,
  type: MediaType.VIDEO,
  status: MediaStatus.PROCESSING,
  failureReason: null,
  postId: null,
  position: 0,
  publicId,
  durationSec: 42,
  aspectRatio: '9:16',
  captionStatus: CaptionStatus.NONE,
  captionLanguage: null,
  transcript: null,
  captions: [],
  discardedAt: null,
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

export const waitingMedia: MediaAsset = {
  ...pendingMedia,
  status: MediaStatus.WAITING_UPLOAD,
  durationSec: null,
  aspectRatio: null,
};

export function uploaded(duration: number): CloudinaryNotification {
  return {
    notification_type: 'upload',
    resource_type: 'video',
    public_id: publicId,
    duration,
    width: 720,
    height: 1280,
    video: { dar: '9:16' },
  };
}

export function streamBuilt(): CloudinaryNotification {
  return {
    notification_type: 'eager',
    resource_type: 'video',
    public_id: publicId,
    eager: [{ transformation: 'sp_auto/m3u8' }],
  };
}
