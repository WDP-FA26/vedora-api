import { Injectable, Logger } from '@nestjs/common';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  CaptionStatus,
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  Post,
  PostStatus,
} from '../mongo/models.js';
import {
  CloudinaryService,
  type CloudinaryVideo,
  STREAM_TRANSFORMATION,
  UPLOAD_SIGNATURE_TTL_SECONDS,
} from '../cloudinary/cloudinary.service.js';
import { CaptionService } from './captions/caption.service.js';
import { PostModerationService } from './post-moderation.service.js';
import {
  CreateUploadResponseDto,
  MediaResponseDto,
} from './dto/media-response.dto.js';
import type { CloudinaryNotification } from './dto/cloudinary-notification.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

const PENDING: readonly MediaStatus[] = [
  MediaStatus.WAITING_UPLOAD,
  MediaStatus.PROCESSING,
];

const LIVE: QueryFilter<MediaAsset> = { discardedAt: null };

const MAX_UNATTACHED_UPLOADS = 5;
const UPLOAD_GRACE_MS = 10 * 60 * 1000;
const REFRESH_INTERVAL_MS = 15 * 1000;
const ENCODING_TIMEOUT_MS = 60 * 60 * 1000;

function streamBuilt(video: CloudinaryVideo): boolean {
  const profile = STREAM_TRANSFORMATION.split('/')[0];
  return (video.derived ?? []).some(
    ({ transformation, format }) =>
      format === 'm3u8' && transformation.split('/')[0] === profile,
  );
}

function aspectRatio(video: CloudinaryVideo): string | null {
  if (video.width && video.height) {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const divisor = gcd(video.width, video.height);
    return `${video.width / divisor}:${video.height / divisor}`;
  }
  if (video.video?.dar && /^\d+:\d+$/.test(video.video.dar)) {
    return video.video.dar;
  }
  return null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly maxVideoDurationSec: number;
  private readonly lastRefresh = new Map<string, number>();

  constructor(
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    private readonly cloudinary: CloudinaryService,
    private readonly captions: CaptionService,
    private readonly postModeration: PostModerationService,
    configService: ConfigService,
  ) {
    this.maxVideoDurationSec = configService.get<number>(
      'MAX_VIDEO_DURATION_SEC',
      180,
    );
  }

  async createUpload(
    ownerId: string,
    type: MediaType,
  ): Promise<CreateUploadResponseDto> {
    this.cloudinary.require();

    const unattached = await this.mediaAssets.countDocuments({
      discardedAt: null,
      ownerId,
      postId: null,
      status: { $ne: MediaStatus.FAILED },
    });
    if (unattached >= MAX_UNATTACHED_UPLOADS) {
      throw new QuotaReachedException(
        'UPLOAD_LIMIT_REACHED',
        'Too many uploads not attached to a post; post or remove them first',
      );
    }

    const id = randomUUID();
    const publicId = this.cloudinary.videoPublicId(id);
    const media = await this.mediaAssets.create({
      _id: id,
      ownerId,
      type,
      publicId,
      status: MediaStatus.WAITING_UPLOAD,
      position: 0,
      captionStatus: CaptionStatus.NONE,
      captions: [],
    });
    return {
      media: this.toResponse(media),
      upload: this.cloudinary.signVideoUpload(publicId),
    };
  }

  async findOwned(id: string, ownerId: string): Promise<MediaResponseDto> {
    let media = await this.mediaAssets
      .findOne({ ...LIVE, _id: id, ownerId })
      .exec();
    if (!media) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Media not found');
    }
    if (!this.cloudinary.webhooksEnabled && PENDING.includes(media.status)) {
      await this.refresh(media);
      media = await this.mediaAssets.findOne({ _id: id }).exec();
    }
    return this.toResponse(media!);
  }

  async removeOwned(id: string, ownerId: string): Promise<void> {
    const media = await this.mediaAssets
      .findOne({ ...LIVE, _id: id, ownerId })
      .exec();
    if (!media) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Media not found');
    }
    if (media.postId) {
      throw new StateConflictException(
        'CONFLICT',
        'Media is attached to a post',
      );
    }
    await this.discard({ _id: id, postId: null });
  }

  async discard(filter: QueryFilter<MediaAsset>): Promise<void> {
    const media = await this.mediaAssets.find({ ...filter, ...LIVE }).exec();
    if (media.length === 0) return;
    await this.mediaAssets.updateMany(
      { _id: { $in: media.map(({ id }) => id) }, ...LIVE },
      { $set: { discardedAt: new Date() } },
    );
    for (const item of media) {
      await this.purge(item);
    }
  }

  async purge(
    media: Pick<MediaAsset, 'id' | 'status' | 'captionStatus' | 'createdAt'>,
  ): Promise<boolean> {
    if (!(await this.deleteFromCloudinary(media))) return false;
    const uploadOpen =
      media.status === MediaStatus.WAITING_UPLOAD &&
      media.createdAt.getTime() >
        Date.now() - UPLOAD_SIGNATURE_TTL_SECONDS * 1000 - UPLOAD_GRACE_MS;
    if (uploadOpen) return false;
    await this.mediaAssets
      .deleteOne({ _id: media.id, discardedAt: { $ne: null } })
      .exec();
    this.lastRefresh.delete(media.id);
    return true;
  }

  async claimForPost(
    session: ClientSession,
    ownerId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    for (const [position, id] of mediaIds.entries()) {
      const claimed = await this.mediaAssets
        .updateOne(
          {
            _id: id,
            ownerId,
            postId: null,
            discardedAt: null,
            status: { $ne: MediaStatus.FAILED },
          },
          { $set: { postId, position } },
          { session },
        )
        .exec();
      if (claimed.modifiedCount !== 1) {
        throw new InvalidInputException(
          'MEDIA_UNAVAILABLE',
          `Media ${id} can't be attached: it doesn't exist, is used by another post, or failed to process`,
        );
      }
    }
  }

  async settlePosts(postIds: string[]): Promise<void> {
    const media = await this.mediaAssets
      .find({ postId: { $in: postIds } })
      .select('postId status')
      .exec();
    const failed = new Set(
      media
        .filter(({ status }) => status === MediaStatus.FAILED)
        .map(({ postId }) => postId),
    );
    const waiting = new Set(
      media
        .filter(({ status }) => status !== MediaStatus.READY)
        .map(({ postId }) => postId),
    );
    await this.posts
      .updateMany(
        { _id: { $in: [...failed] }, status: PostStatus.PROCESSING },
        { $set: { status: PostStatus.FAILED } },
      )
      .exec();
    const ready = postIds.filter((id) => !waiting.has(id) && !failed.has(id));
    const published = await this.postModeration.settle(ready);
    if (published > 0) this.captions.schedule();
  }

  async handleNotification(
    notification: CloudinaryNotification,
  ): Promise<void> {
    if (notification.resource_type && notification.resource_type !== 'video') {
      return;
    }
    const publicId = notification.public_id;
    if (!publicId || !this.cloudinary.mediaIdOf(publicId)) return;

    switch (notification.notification_type) {
      case 'upload':
        await this.applyUploaded(notification as CloudinaryVideo);
        break;
      case 'eager': {
        const failed = (notification.eager ?? []).some(
          (item) => item.status === 'failed' || item.error !== undefined,
        );
        if (failed) {
          await this.markFailed(
            { publicId },
            MediaFailureReason.ENCODING_FAILED,
          );
        } else {
          await this.applyStreamBuilt(publicId);
        }
        break;
      }
      default:
        break;
    }
  }

  async refresh(media: MediaAsset): Promise<void> {
    if (!PENDING.includes(media.status) || !this.cloudinary.configured) return;
    const last = this.lastRefresh.get(media.id) ?? 0;
    if (Date.now() - last < REFRESH_INTERVAL_MS) return;
    this.lastRefresh.set(media.id, Date.now());

    try {
      const video = await this.cloudinary.findVideo(media.publicId);
      if (!video) {
        await this.handleMissing(media);
        return;
      }
      await this.applyUploaded(video);
      if (streamBuilt(video)) {
        await this.applyStreamBuilt(media.publicId, video);
      } else if (
        media.status === MediaStatus.PROCESSING &&
        media.updatedAt.getTime() < Date.now() - ENCODING_TIMEOUT_MS
      ) {
        await this.markFailed(
          { _id: media.id },
          MediaFailureReason.ENCODING_FAILED,
        );
      }
    } catch (error) {
      this.logger.warn(`Refreshing media ${media.id} failed: ${String(error)}`);
    }
  }

  async deleteFromCloudinary(
    media: Pick<MediaAsset, 'id' | 'captionStatus'>,
  ): Promise<boolean> {
    if (!this.cloudinary.configured) return true;
    try {
      await this.cloudinary.deleteMedia(
        media.id,
        media.captionStatus !== CaptionStatus.NONE &&
          media.captionStatus !== CaptionStatus.NO_SPEECH,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Deleting Cloudinary files of media ${media.id} failed: ${String(error)}`,
      );
      return false;
    }
  }

  toResponse(media: MediaAsset): MediaResponseDto {
    const ready = media.status === MediaStatus.READY;
    return {
      id: media.id,
      type: media.type,
      status: media.status,
      failureReason: media.failureReason,
      publicId: media.publicId,
      playbackUrl: ready ? this.cloudinary.hlsUrl(media.publicId) : null,
      posterUrl: ready ? this.cloudinary.posterUrl(media.publicId) : null,
      durationSec: media.durationSec,
      aspectRatio: media.aspectRatio,
      captions: media.captions
        .map(({ languageCode, name, isOriginal, url }) => ({
          languageCode,
          name,
          isOriginal,
          url,
        }))
        .sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal)),
    };
  }

  private async handleMissing(media: MediaAsset): Promise<void> {
    if (media.status === MediaStatus.PROCESSING) {
      await this.markFailed(
        { _id: media.id },
        MediaFailureReason.UPLOAD_ERRORED,
      );
      return;
    }
    const expiresAt =
      media.createdAt.getTime() +
      UPLOAD_SIGNATURE_TTL_SECONDS * 1000 +
      UPLOAD_GRACE_MS;
    if (Date.now() > expiresAt) {
      await this.markFailed(
        { _id: media.id },
        MediaFailureReason.UPLOAD_TIMED_OUT,
      );
    }
  }

  private async applyUploaded(video: CloudinaryVideo): Promise<void> {
    const media = await this.mediaAssets
      .findOne({ publicId: video.public_id })
      .exec();
    if (!media || media.discardedAt) {
      if (media) await this.purge(media);
      else await this.deleteOrphan(video.public_id);
      return;
    }
    if (media.status !== MediaStatus.WAITING_UPLOAD) return;

    if ((video.duration ?? 0) > this.maxVideoDurationSec) {
      await this.markFailed({ _id: media.id }, MediaFailureReason.TOO_LONG);
      return;
    }
    await this.mediaAssets.updateOne(
      { _id: media.id, status: MediaStatus.WAITING_UPLOAD },
      {
        $set: {
          status: MediaStatus.PROCESSING,
          durationSec: video.duration ?? null,
          aspectRatio: aspectRatio(video),
        },
      },
    );
  }

  private async applyStreamBuilt(
    publicId: string,
    video?: CloudinaryVideo,
  ): Promise<void> {
    let media = await this.mediaAssets.findOne({ ...LIVE, publicId }).exec();
    if (!media || !PENDING.includes(media.status)) return;
    if (media.status === MediaStatus.WAITING_UPLOAD) {
      const details = video ?? (await this.cloudinary.findVideo(publicId));
      if (!details) return;
      await this.applyUploaded(details);
      media = await this.mediaAssets.findOne({ _id: media.id }).exec();
      if (!media || media.status !== MediaStatus.PROCESSING) return;
    }

    const ready = await this.mediaAssets
      .findOneAndUpdate(
        { ...LIVE, _id: media.id, status: MediaStatus.PROCESSING },
        { $set: { status: MediaStatus.READY } },
        { returnDocument: 'after' },
      )
      .exec();
    if (ready) {
      this.lastRefresh.delete(ready.id);
      if (ready.postId) await this.settlePosts([ready.postId]);
    }
  }

  private async markFailed(
    match: QueryFilter<MediaAsset>,
    reason: MediaFailureReason,
  ): Promise<void> {
    const media = await this.mediaAssets
      .findOneAndUpdate(
        { ...LIVE, ...match, status: { $in: [...PENDING] } },
        { $set: { status: MediaStatus.FAILED, failureReason: reason } },
        { returnDocument: 'after' },
      )
      .exec();
    if (media) {
      this.logger.log(`Media ${media.id} failed: ${reason}`);
      this.lastRefresh.delete(media.id);
      if (media.postId) await this.settlePosts([media.postId]);
      await this.deleteFromCloudinary(media);
    }
  }

  private async deleteOrphan(publicId: string): Promise<void> {
    const mediaId = this.cloudinary.mediaIdOf(publicId);
    if (!mediaId) return;
    this.logger.log(`Deleting unclaimed Cloudinary video ${publicId}`);
    await this.deleteFromCloudinary({
      id: mediaId,
      captionStatus: CaptionStatus.NONE,
    });
  }
}
