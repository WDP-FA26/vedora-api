import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import {
  CaptionStatus,
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  Post,
  PostStatus,
  type Stored,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import {
  CloudinaryService,
  type CloudinaryVideo,
  STREAM_TRANSFORMATION,
  UPLOAD_SIGNATURE_TTL_SECONDS,
} from '../cloudinary/cloudinary.service';
import { CaptionService } from './caption.service';
import {
  CreateUploadResponseDto,
  MediaResponseDto,
} from './dto/media-response.dto';
import type { CloudinaryNotification } from './dto/cloudinary-notification';

const PENDING: readonly MediaStatus[] = [
  MediaStatus.WAITING_UPLOAD,
  MediaStatus.PROCESSING,
];

/** Rows that haven't been discarded; every user-facing query uses it. */
const LIVE: QueryFilter<MediaAsset> = { discardedAt: null };

/** Unattached uploads a user may hold at once, so one account can't flood Cloudinary. */
const MAX_UNATTACHED_UPLOADS = 5;
/** Slack after the signature expires for a last chunk still in flight. */
const UPLOAD_GRACE_MS = 10 * 60 * 1000;
/** Polls of one row's Admin API state are at least this far apart (500 calls/hour). */
const REFRESH_INTERVAL_MS = 15 * 1000;
/** A stream that isn't built by now never will be. */
const ENCODING_TIMEOUT_MS = 60 * 60 * 1000;

/** Whether the HLS eager job has finished, judging by the derived files. */
function streamBuilt(video: CloudinaryVideo): boolean {
  const profile = STREAM_TRANSFORMATION.split('/')[0];
  return (video.derived ?? []).some(
    ({ transformation, format }) =>
      format === 'm3u8' && transformation.split('/')[0] === profile,
  );
}

/**
 * `16:9` from the pixel size Cloudinary reports for the displayed frame, else
 * from the display aspect ratio. The `dar` of a phone video ignores its
 * rotation flag, so a portrait clip would read as landscape.
 */
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

/**
 * Videos go straight from the browser to Cloudinary: `createUpload` signs a
 * direct upload that also starts an eager job building the HLS stream.
 * Cloudinary reports the upload and the finished stream through
 * notifications (`handleNotification`). When those aren't configured (local
 * dev) or one was missed, `refresh` asks the Admin API instead. Every
 * transition is a conditional update, so replays and out-of-order
 * notifications are harmless.
 *
 * Discarding is two-phase: `discard` marks the row, then `purge` deletes the
 * Cloudinary files and only drops the row once nothing can arrive any more.
 * A file whose upload finishes after its row is gone is deleted by its
 * notification, so nothing lingers in Cloudinary.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly maxVideoDurationSec: number;
  /** When each row last asked the Admin API, to stay under its rate limit. */
  private readonly lastRefresh = new Map<string, number>();

  constructor(
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    private readonly mongo: MongoService,
    private readonly cloudinary: CloudinaryService,
    private readonly captions: CaptionService,
    configService: ConfigService,
  ) {
    this.maxVideoDurationSec = configService.get<number>(
      'MAX_VIDEO_DURATION_SEC',
      180,
    );
  }

  /** Only VIDEO for now; IMAGE will get presigned storage URLs. */
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
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'UPLOAD_LIMIT_REACHED',
          message:
            'Too many uploads not attached to a post; post or remove them first',
        },
        HttpStatus.TOO_MANY_REQUESTS,
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
      throw new NotFoundException('Media not found');
    }
    if (!this.cloudinary.webhooksEnabled && PENDING.includes(media.status)) {
      await this.refresh(media);
      media = await this.mediaAssets.findOne({ _id: id }).exec();
    }
    return this.toResponse(media!);
  }

  /** Removes an upload the user dropped from the composer before posting. */
  async removeOwned(id: string, ownerId: string): Promise<void> {
    const media = await this.mediaAssets
      .findOne({ ...LIVE, _id: id, ownerId })
      .exec();
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    if (media.postId) {
      throw new ConflictException('Media is attached to a post');
    }
    await this.discard({ _id: id, postId: null });
  }

  /**
   * Hides the matching media from every query, then deletes it from
   * Cloudinary. Rows that can't be confirmed gone yet are retried by `purge`.
   */
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

  /**
   * Deletes a discarded video from Cloudinary, then from our database.
   * Cloudinary goes first: if it fails, the row stays (still discarded) and
   * the `purgeDiscarded` cron tries again. A row whose upload could still
   * finish also stays until its signature has expired. Returns whether the
   * video is fully gone.
   */
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

  /**
   * Attaches the owner's uploads to a new post, in `mediaIds` order. Runs in
   * the post's transaction (`session`); each claim is conditional, so media
   * that belongs to someone else, is already attached or has failed is
   * rejected.
   */
  async claimForPost(
    session: ClientSession,
    ownerId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    const media = this.mongo.db.collection<Stored<MediaAsset>>('media_assets');
    for (const [position, id] of mediaIds.entries()) {
      const claimed = await media.updateOne(
        {
          _id: id,
          ownerId,
          postId: null,
          discardedAt: null,
          status: { $ne: MediaStatus.FAILED },
        },
        { $set: { postId, position, updatedAt: new Date() } },
        { session },
      );
      if (claimed.modifiedCount !== 1) {
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: 'MEDIA_UNAVAILABLE',
          message: `Media ${id} can't be attached: it doesn't exist, is used by another post, or failed to process`,
        });
      }
    }
  }

  /**
   * Moves the PROCESSING posts among `postIds` to FAILED if any of their
   * media failed, or to PUBLISHED once all of it is READY (a post without
   * media publishes at once). Call it after any change to media status or
   * attachment has been committed: whichever change lands last then sees the
   * final state, so concurrent updates can't strand a post. Videos of posts
   * it publishes are then queued for captions.
   */
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
    const published = await this.posts
      .updateMany(
        {
          _id: { $in: postIds, $nin: [...waiting] },
          status: PostStatus.PROCESSING,
        },
        { $set: { status: PostStatus.PUBLISHED, publishedAt: new Date() } },
      )
      .exec();
    if (published.modifiedCount > 0) this.captions.schedule();
  }

  /** Applies a verified Cloudinary notification. */
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

  /** Brings pending media up to date from the Admin API, for missed notifications. */
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

  /**
   * Deletes the Cloudinary side of `media`. Returns whether Cloudinary is
   * confirmed to hold nothing for it; failures are logged, not thrown, so
   * callers can retry later.
   */
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

  /** No file in Cloudinary: still uploading, expired, or deleted. */
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

  /** The file arrived: record its length and shape, enforce the limit. */
  private async applyUploaded(video: CloudinaryVideo): Promise<void> {
    const media = await this.mediaAssets
      .findOne({ publicId: video.public_id })
      .exec();
    if (!media || media.discardedAt) {
      // Discarded, or its row is already gone: nobody will post this file.
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

  /**
   * The HLS stream is built. The stream can finish before the upload
   * notification arrives; the duration check needs the upload's details,
   * so those are read from the Admin API first.
   */
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
      // A failed video can never play; free the storage now. The row stays
      // so the author sees why, and discarding it later retries this.
      await this.deleteFromCloudinary(media);
    }
  }

  /** Deletes a file in our folder that no row claims. */
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
