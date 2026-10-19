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
import {
  MediaAsset,
  MediaCaption,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  PostStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  CloudinaryService,
  type CloudinaryVideo,
  STREAM_TRANSFORMATION,
  UPLOAD_SIGNATURE_TTL_SECONDS,
} from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { CaptionService } from './caption.service';
import {
  CreateUploadResponseDto,
  MediaResponseDto,
} from './dto/media-response.dto';
import type { CloudinaryNotification } from './dto/cloudinary-notification';

const PENDING: MediaStatus[] = [
  MediaStatus.WAITING_UPLOAD,
  MediaStatus.PROCESSING,
];

/** Rows that haven't been discarded; every user-facing query uses it. */
const LIVE = { discardedAt: null } satisfies Prisma.MediaAssetWhereInput;

/** Unattached uploads a user may hold at once, so one account can't flood Cloudinary. */
const MAX_UNATTACHED_UPLOADS = 5;
/** Slack after the signature expires for a last chunk still in flight. */
const UPLOAD_GRACE_MS = 10 * 60 * 1000;
/** Polls of one row's Admin API state are at least this far apart (500 calls/hour). */
const REFRESH_INTERVAL_MS = 15 * 1000;
/** A stream that isn't built by now never will be. */
const ENCODING_TIMEOUT_MS = 60 * 60 * 1000;

type MediaWithCaptions = MediaAsset & { captions?: MediaCaption[] };

/** Whether the HLS eager job has finished, judging by the derived files. */
function streamBuilt(video: CloudinaryVideo): boolean {
  const profile = STREAM_TRANSFORMATION.split('/')[0];
  return (video.derived ?? []).some(
    ({ transformation, format }) =>
      format === 'm3u8' && transformation.split('/')[0] === profile,
  );
}

/** `16:9` from the display aspect ratio, else from the pixel size. */
function aspectRatio(video: CloudinaryVideo): string | null {
  if (video.video?.dar && /^\d+:\d+$/.test(video.video.dar)) {
    return video.video.dar;
  }
  if (!video.width || !video.height) return null;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(video.width, video.height);
  return `${video.width / divisor}:${video.height / divisor}`;
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
    private readonly prisma: PrismaService,
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

    const unattached = await this.prisma.mediaAsset.count({
      where: {
        ...LIVE,
        ownerId,
        postId: null,
        status: { not: MediaStatus.FAILED },
      },
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
    const media = await this.prisma.mediaAsset.create({
      data: { id, ownerId, type, publicId },
    });
    return {
      media: this.toResponse(media),
      upload: this.cloudinary.signVideoUpload(publicId),
    };
  }

  async findOwned(id: string, ownerId: string): Promise<MediaResponseDto> {
    let media = await this.prisma.mediaAsset.findFirst({
      where: { ...LIVE, id, ownerId },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    if (!this.cloudinary.webhooksEnabled && PENDING.includes(media.status)) {
      await this.refresh(media);
      media = await this.prisma.mediaAsset.findUniqueOrThrow({
        where: { id },
      });
    }
    return this.toResponse(media);
  }

  /** Removes an upload the user dropped from the composer before posting. */
  async removeOwned(id: string, ownerId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { ...LIVE, id, ownerId },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    if (media.postId) {
      throw new ConflictException('Media is attached to a post');
    }
    await this.discard({ id, postId: null });
  }

  /**
   * Hides the matching media from every query, then deletes it from
   * Cloudinary. Rows that can't be confirmed gone yet are retried by `purge`.
   */
  async discard(where: Prisma.MediaAssetWhereInput): Promise<void> {
    const media = await this.prisma.mediaAsset.findMany({
      where: { ...where, ...LIVE },
    });
    if (media.length === 0) return;
    await this.prisma.mediaAsset.updateMany({
      where: { id: { in: media.map(({ id }) => id) }, ...LIVE },
      data: { discardedAt: new Date() },
    });
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
    await this.prisma.mediaAsset.deleteMany({
      where: { id: media.id, discardedAt: { not: null } },
    });
    this.lastRefresh.delete(media.id);
    return true;
  }

  /**
   * Attaches the owner's uploads to a new post, in `mediaIds` order. Runs in
   * the post's transaction; each claim is conditional, so media that belongs
   * to someone else, is already attached or has failed is rejected.
   */
  async claimForPost(
    tx: Prisma.TransactionClient,
    ownerId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    for (const [position, id] of mediaIds.entries()) {
      const { count } = await tx.mediaAsset.updateMany({
        where: {
          ...LIVE,
          id,
          ownerId,
          postId: null,
          status: { not: MediaStatus.FAILED },
        },
        data: { postId, position },
      });
      if (count !== 1) {
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
   * Moves PROCESSING posts matching `where` to FAILED if any of their media
   * failed, or to PUBLISHED once all of it is READY. Call it after any change
   * to media status or attachment has been committed: whichever change lands
   * last then sees the final state, so concurrent updates can't strand a post.
   * Videos of posts it publishes are then queued for captions.
   */
  async settlePosts(where: Prisma.PostWhereInput): Promise<void> {
    await this.prisma.post.updateMany({
      where: {
        AND: [
          where,
          { status: PostStatus.PROCESSING },
          { media: { some: { status: MediaStatus.FAILED } } },
        ],
      },
      data: { status: PostStatus.FAILED },
    });
    const { count } = await this.prisma.post.updateMany({
      where: {
        AND: [
          where,
          { status: PostStatus.PROCESSING },
          { media: { every: { status: MediaStatus.READY } } },
        ],
      },
      data: { status: PostStatus.PUBLISHED, publishedAt: new Date() },
    });
    if (count > 0) this.captions.schedule();
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
          { id: media.id },
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
        media.captionStatus !== 'NONE' && media.captionStatus !== 'NO_SPEECH',
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Deleting Cloudinary files of media ${media.id} failed: ${String(error)}`,
      );
      return false;
    }
  }

  toResponse(media: MediaWithCaptions): MediaResponseDto {
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
      captions: (media.captions ?? [])
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
        { id: media.id },
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
        { id: media.id },
        MediaFailureReason.UPLOAD_TIMED_OUT,
      );
    }
  }

  /** The file arrived: record its length and shape, enforce the limit. */
  private async applyUploaded(video: CloudinaryVideo): Promise<void> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { publicId: video.public_id },
    });
    if (!media || media.discardedAt) {
      // Discarded, or its row is already gone: nobody will post this file.
      if (media) await this.purge(media);
      else await this.deleteOrphan(video.public_id);
      return;
    }
    if (media.status !== MediaStatus.WAITING_UPLOAD) return;

    if ((video.duration ?? 0) > this.maxVideoDurationSec) {
      await this.markFailed({ id: media.id }, MediaFailureReason.TOO_LONG);
      return;
    }
    await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: MediaStatus.WAITING_UPLOAD },
      data: {
        status: MediaStatus.PROCESSING,
        durationSec: video.duration ?? null,
        aspectRatio: aspectRatio(video),
      },
    });
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
    let media = await this.prisma.mediaAsset.findFirst({
      where: { ...LIVE, publicId },
    });
    if (!media || !PENDING.includes(media.status)) return;
    if (media.status === MediaStatus.WAITING_UPLOAD) {
      const details = video ?? (await this.cloudinary.findVideo(publicId));
      if (!details) return;
      await this.applyUploaded(details);
      media = await this.prisma.mediaAsset.findUniqueOrThrow({
        where: { id: media.id },
      });
      if (media.status !== MediaStatus.PROCESSING) return;
    }

    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: MediaStatus.PROCESSING, ...LIVE },
      data: { status: MediaStatus.READY },
    });
    if (count > 0) {
      this.lastRefresh.delete(media.id);
      await this.settlePosts({ media: { some: { id: media.id } } });
    }
  }

  private async markFailed(
    where: Prisma.MediaAssetWhereInput,
    reason: MediaFailureReason,
  ): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { ...where, ...LIVE },
    });
    if (!media) return;
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: { in: PENDING } },
      data: { status: MediaStatus.FAILED, failureReason: reason },
    });
    if (count > 0) {
      this.logger.log(`Media ${media.id} failed: ${reason}`);
      this.lastRefresh.delete(media.id);
      await this.settlePosts({ media: { some: { id: media.id } } });
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
    await this.deleteFromCloudinary({ id: mediaId, captionStatus: 'NONE' });
  }
}
