import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

/** Adaptive HLS, built by an eager job right after the upload. */
export const STREAM_TRANSFORMATION = 'sp_auto/m3u8';
/** Cloudinary rejects upload signatures older than this. */
export const UPLOAD_SIGNATURE_TTL_SECONDS = 3600;
/** Chunk size for large uploads; Cloudinary needs at least 5 MB per chunk. */
export const UPLOAD_CHUNK_BYTES = 20 * 1024 * 1024;

export interface SignedUpload {
  /** POST the file here as multipart form data, with `fields`. */
  url: string;
  fields: Record<string, string>;
  /** Files above this go in chunks of this size (`X-Unique-Upload-Id`). */
  chunkSize: number;
}

/** The video fields we read, shared by Admin API answers and notifications. */
const cloudinaryVideoSchema = z.object({
  public_id: z.string(),
  duration: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** Display aspect ratio, e.g. `16:9`. */
  video: z.object({ dar: z.string().optional() }).optional(),
  /** Generated files; the HLS stream appears here once it's built. */
  derived: z
    .array(z.object({ transformation: z.string(), format: z.string() }))
    .optional(),
});

export type CloudinaryVideo = z.infer<typeof cloudinaryVideoSchema>;

/**
 * Holds the Cloudinary credentials. Endpoints that need Cloudinary answer
 * 503 while `CLOUDINARY_*` are empty, like Google sign-in does.
 *
 * Folder layout: `<folder>/videos/<mediaId>` (video) and
 * `<folder>/captions/<mediaId>/<lang>.vtt` (raw).
 */
@Injectable()
export class CloudinaryService {
  readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly folder: string;
  /**
   * Whether the console's notification URL points at this API. Without it
   * nothing reports finished uploads, so reads of pending media poll the
   * Admin API instead.
   */
  readonly webhooksEnabled: boolean;

  constructor(configService: ConfigService) {
    this.cloudName = configService.get<string>('CLOUDINARY_CLOUD_NAME', '');
    this.apiKey = configService.get<string>('CLOUDINARY_API_KEY', '');
    this.apiSecret = configService.get<string>('CLOUDINARY_API_SECRET', '');
    this.folder = configService.get<string>('CLOUDINARY_FOLDER', 'vedora');
    this.webhooksEnabled = configService.get<boolean>(
      'CLOUDINARY_WEBHOOKS_ENABLED',
      false,
    );
    if (this.configured) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      });
    }
  }

  get configured(): boolean {
    return this.cloudName !== '' && this.apiKey !== '' && this.apiSecret !== '';
  }

  /** The SDK, configured; throws 503 when Cloudinary isn't set up. */
  require(): typeof cloudinary {
    if (!this.configured) {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Video uploads are not configured',
      );
    }
    return cloudinary;
  }

  videoPublicId(mediaId: string): string {
    return `${this.folder}/videos/${mediaId}`;
  }

  captionPrefix(mediaId: string): string {
    return `${this.folder}/captions/${mediaId}/`;
  }

  /** The media ID inside one of our video public IDs, else null. */
  mediaIdOf(publicId: string): string | null {
    const prefix = `${this.folder}/videos/`;
    return publicId.startsWith(prefix) ? publicId.slice(prefix.length) : null;
  }

  /**
   * Signs a direct upload of one video to `publicId`. The signature pins the
   * public ID and the HLS eager job, so the browser can't change either.
   */
  signVideoUpload(publicId: string): SignedUpload {
    return this.signUpload({
      public_id: publicId,
      asset_folder: `${this.folder}/videos`,
      eager: STREAM_TRANSFORMATION,
      eager_async: 'true',
    });
  }

  /**
   * Signs a direct upload of a video that a blog embeds. It lives under
   * `<folder>/blog-videos/`, outside the post-media bookkeeping, so the media
   * sweeps and webhooks leave it alone. Delivered as progressive MP4.
   */
  signBlogVideoUpload(): { upload: SignedUpload; url: string } {
    const folder = `${this.folder}/blog-videos`;
    const publicId = `${folder}/${randomUUID()}`;
    return {
      upload: this.signUpload({ public_id: publicId, asset_folder: folder }),
      url: `https://res.cloudinary.com/${this.cloudName}/video/upload/q_auto/${publicId}.mp4`,
    };
  }

  /** Signs `params` plus a fresh timestamp for a direct video upload. */
  private signUpload(params: Record<string, string>): SignedUpload {
    this.require();
    const signed = {
      ...params,
      overwrite: 'false',
      timestamp: String(Math.round(Date.now() / 1000)),
    };
    const signature = cloudinary.utils.api_sign_request(signed, this.apiSecret);
    return {
      url: `https://api.cloudinary.com/v1_1/${this.cloudName}/video/upload`,
      fields: { ...signed, api_key: this.apiKey, signature },
      chunkSize: UPLOAD_CHUNK_BYTES,
    };
  }

  /** The original file, as uploaded. */
  originalUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/${publicId}`;
  }

  hlsUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/${STREAM_TRANSFORMATION.replace('/m3u8', '')}/${publicId}.m3u8`;
  }

  posterUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/so_0,q_auto/${publicId}.jpg`;
  }

  /**
   * Checks `X-Cld-Signature`: a hash of the body, `X-Cld-Timestamp` and the
   * API secret. The account's signature setting picks SHA-1 or SHA-256, so
   * either is accepted.
   */
  verifyNotification(
    body: string,
    timestamp: string,
    signature: string,
    maxAgeSec = 7200,
  ): boolean {
    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) return false;
    if (Math.abs(Date.now() / 1000 - sentAt) > maxAgeSec) return false;
    const given = Buffer.from(signature, 'utf8');
    return (['sha1', 'sha256'] as const).some((algorithm) => {
      const expected = Buffer.from(
        createHash(algorithm)
          .update(body + timestamp + this.apiSecret)
          .digest('hex'),
        'utf8',
      );
      return (
        expected.length === given.length && timingSafeEqual(expected, given)
      );
    });
  }

  /** The video, or null when Cloudinary has no such file. */
  async findVideo(publicId: string): Promise<CloudinaryVideo | null> {
    try {
      const resource: unknown = await this.require().api.resource(publicId, {
        resource_type: 'video',
      });
      return cloudinaryVideoSchema.parse(resource);
    } catch (error) {
      if (httpCode(error) === 404) return null;
      throw error;
    }
  }

  /** Deletes the video and its captions; missing files count as deleted. */
  async deleteMedia(mediaId: string, withCaptions: boolean): Promise<void> {
    const sdk = this.require();
    await sdk.uploader.destroy(this.videoPublicId(mediaId), {
      resource_type: 'video',
      invalidate: true,
    });
    if (withCaptions) {
      await sdk.api.delete_resources_by_prefix(this.captionPrefix(mediaId), {
        resource_type: 'raw',
        invalidate: true,
      });
    }
  }

  /** Stores a WebVTT file and returns its public URL. */
  async uploadCaption(
    mediaId: string,
    language: string,
    vtt: string,
  ): Promise<string> {
    const result = await this.require().uploader.upload(
      `data:text/vtt;base64,${Buffer.from(vtt, 'utf8').toString('base64')}`,
      {
        resource_type: 'raw',
        public_id: `${this.captionPrefix(mediaId)}${language}.vtt`,
        asset_folder: `${this.folder}/captions`,
        overwrite: true,
        invalidate: true,
      },
    );
    return result.secure_url;
  }
}

/** The HTTP status of an SDK error, which rejects with `{ error }`. */
function httpCode(error: unknown): number | undefined {
  const inner = (error as { error?: { http_code?: unknown } } | null)?.error;
  return typeof inner?.http_code === 'number' ? inner.http_code : undefined;
}
