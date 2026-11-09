import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

export const STREAM_TRANSFORMATION = 'sp_auto/m3u8';
export const UPLOAD_SIGNATURE_TTL_SECONDS = 3600;
export const UPLOAD_CHUNK_BYTES = 20 * 1024 * 1024;

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
      url: `https://res.cloudinary.com/${this.cloudName}/video/upload/q_auto/${publicId}.mp4`,
    };
  }

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

  originalUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/${publicId}`;
  }

  hlsUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/${STREAM_TRANSFORMATION.replace('/m3u8', '')}/${publicId}.m3u8`;
  }

  frameUrl(publicId: string, seconds: number): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/so_${seconds.toFixed(1)},w_1024,c_limit,f_jpg/${publicId}.jpg`;
  }

  posterUrl(publicId: string): string {
    return `https://res.cloudinary.com/${this.cloudName}/video/upload/so_0,q_auto/${publicId}.jpg`;
  }

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
