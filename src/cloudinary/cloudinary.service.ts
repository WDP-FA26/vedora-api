import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

export const STREAM_TRANSFORMATION =
  runtimeConfig.CLOUDINARY_STREAM_TRANSFORMATION;
export const UPLOAD_SIGNATURE_TTL_SECONDS =
  runtimeConfig.CLOUDINARY_UPLOAD_SIGNATURE_TTL_SECONDS;
export const UPLOAD_CHUNK_BYTES =
  runtimeConfig.CLOUDINARY_UPLOAD_CHUNK_MB * 1048576;
export const IMAGE_FORMATS = runtimeConfig.CLOUDINARY_IMAGE_FORMATS;

export interface SignedUpload {
  url: string;
  fields: Record<string, string>;
  chunkSize: number;
}

const cloudinaryVideoSchema = z.object({
  public_id: z.string(),
  duration: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  video: z.object({ dar: z.string().optional() }).optional(),
  derived: z
    .array(z.object({ transformation: z.string(), format: z.string() }))
    .optional(),
});

export type CloudinaryVideo = z.infer<typeof cloudinaryVideoSchema>;

@Injectable()
export class CloudinaryService {
  readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly folder: string;
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

  mediaIdOf(publicId: string): string | null {
    const prefix = `${this.folder}/videos/`;
    return publicId.startsWith(prefix) ? publicId.slice(prefix.length) : null;
  }

  signVideoUpload(publicId: string): SignedUpload {
    return this.signUpload({
      public_id: publicId,
      asset_folder: `${this.folder}/videos`,
      eager: STREAM_TRANSFORMATION,
      eager_async: 'true',
    });
  }

  signBlogVideoUpload(): { upload: SignedUpload; url: string } {
    const folder = `${this.folder}/blog-videos`;
    const publicId = `${folder}/${randomUUID()}`;
    return {
      upload: this.signUpload({ public_id: publicId, asset_folder: folder }),
      url: `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/q_auto/${publicId}.mp4`,
    };
  }

  isBlogVideoUrl(url: string): boolean {
    if (!this.cloudName) return false;
    const prefix = `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/`;
    if (!url.startsWith(prefix)) return false;
    const rest = url.slice(prefix.length).split(/[?#]/)[0];
    return (
      !rest.split('/').includes('..') &&
      (rest.startsWith(`${this.folder}/blog-videos/`) ||
        rest.includes(`/${this.folder}/blog-videos/`))
    );
  }

  signRecipeImageUpload(): { upload: SignedUpload; url: string } {
    const folder = `${this.folder}/recipe-images`;
    const publicId = `${folder}/${randomUUID()}`;
    return {
      upload: this.signUpload(
        {
          public_id: publicId,
          asset_folder: folder,
          allowed_formats: IMAGE_FORMATS,
        },
        'image',
      ),
      url: `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/image/upload/f_auto,q_auto/${publicId}`,
    };
  }

  private signUpload(
    params: Record<string, string>,
    resourceType: 'video' | 'image' = 'video',
  ): SignedUpload {
    this.require();
    const signed = {
      ...params,
      overwrite: 'false',
      timestamp: String(Math.round(Date.now() / 1000)),
    };
    const signature = cloudinary.utils.api_sign_request(signed, this.apiSecret);
    return {
      url: `${runtimeConfig.CLOUDINARY_API_BASE_URL}/${this.cloudName}/${resourceType}/upload`,
      fields: { ...signed, api_key: this.apiKey, signature },
      chunkSize: UPLOAD_CHUNK_BYTES,
    };
  }

  originalUrl(publicId: string): string {
    return `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/${publicId}`;
  }

  hlsUrl(publicId: string): string {
    return `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/${STREAM_TRANSFORMATION.replace('/m3u8', '')}/${publicId}.m3u8`;
  }

  frameUrl(publicId: string, seconds: number): string {
    return `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/so_${seconds.toFixed(1)},w_${runtimeConfig.CLOUDINARY_FRAME_MAX_WIDTH},c_limit,f_jpg/${publicId}.jpg`;
  }

  posterUrl(publicId: string): string {
    return `${runtimeConfig.CLOUDINARY_CDN_BASE_URL}/${this.cloudName}/video/upload/so_0,q_auto/${publicId}.jpg`;
  }

  verifyNotification(
    body: string,
    timestamp: string,
    signature: string,
    maxAgeSec = runtimeConfig.CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS,
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

  async findVideo(publicId: string): Promise<CloudinaryVideo | null> {
    try {
      // The SDK types this as `any`; parsing it straight away keeps that out
      // of our code. Without media_metadata the Admin API leaves out
      // `duration`, so videos settled by polling (no webhook) lost their length.
      return cloudinaryVideoSchema.parse(
        await this.require().api.resource(publicId, {
          resource_type: 'video',
          media_metadata: true,
        }),
      );
    } catch (error) {
      if (httpCode(error) === 404) return null;
      throw error;
    }
  }

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

function httpCode(error: unknown): number | undefined {
  const inner = (error as { error?: { http_code?: unknown } } | null)?.error;
  return typeof inner?.http_code === 'number' ? inner.http_code : undefined;
}
