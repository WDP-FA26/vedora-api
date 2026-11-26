import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignedUploadDto } from './presigned-upload.dto.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

export enum StorageTarget {
  Knowledge = 'knowledge',
  Profiles = 'profiles',
  Verifications = 'verifications',
  Blogs = 'blogs',
  Support = 'support',
}

const BUCKET_SETUP: Record<StorageTarget, { publicRead: boolean }> = {
  [StorageTarget.Knowledge]: { publicRead: false },
  [StorageTarget.Profiles]: { publicRead: true },
  [StorageTarget.Verifications]: { publicRead: false },
  [StorageTarget.Blogs]: { publicRead: true },
  [StorageTarget.Support]: { publicRead: false },
};

interface StorageClients {
  internal: S3Client;
  presigner: S3Client;
}

export const UPLOAD_TTL_SECONDS = runtimeConfig.STORAGE_UPLOAD_TTL_SECONDS;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly clients: StorageClients | null;
  private readonly publicUrl: string;
  private readonly region: string;
  private readonly buckets: Record<StorageTarget, string>;

  constructor(config: ConfigService) {
    const endpoint = config.getOrThrow<string>('STORAGE_ENDPOINT');
    const accessKeyId = config.getOrThrow<string>('STORAGE_ACCESS_KEY');
    const secretAccessKey = config.getOrThrow<string>('STORAGE_SECRET_KEY');
    this.publicUrl = config
      .getOrThrow<string>('STORAGE_PUBLIC_URL')
      .replace(/\/+$/, '');
    this.region = config.getOrThrow<string>('STORAGE_REGION');
    this.buckets = {
      [StorageTarget.Knowledge]: config.getOrThrow<string>(
        'STORAGE_KNOWLEDGE_BUCKET',
      ),
      [StorageTarget.Profiles]: config.getOrThrow<string>(
        'STORAGE_PROFILES_BUCKET',
      ),
      [StorageTarget.Verifications]: config.getOrThrow<string>(
        'STORAGE_VERIFICATIONS_BUCKET',
      ),
      [StorageTarget.Blogs]: config.getOrThrow<string>('STORAGE_BLOGS_BUCKET'),
      [StorageTarget.Support]: config.getOrThrow<string>(
        'STORAGE_SUPPORT_BUCKET',
      ),
    };
    const client = (url: string): S3Client =>
      new S3Client({
        endpoint: url,
        region: this.region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: {
          connectionTimeout: runtimeConfig.STORAGE_CONNECTION_TIMEOUT_MS,
          requestTimeout: runtimeConfig.STORAGE_REQUEST_TIMEOUT_MS,
        },
      });
    const configured =
      endpoint && accessKeyId && secretAccessKey && this.publicUrl;
    this.clients = configured
      ? { internal: client(endpoint), presigner: client(this.publicUrl) }
      : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.clients) {
      this.logger.warn('Storage is not configured; uploads answer 503');
      return;
    }
    const { internal } = this.clients;
    try {
      await Promise.all(
        Object.values(StorageTarget).map((target) =>
          this.ensureBucket(internal, target),
        ),
      );
    } catch (error) {
      this.logger.error(`Could not set up storage buckets: ${String(error)}`);
    }
  }

  isConfigured(): boolean {
    return this.clients !== null;
  }

  async presignUpload(
    target: StorageTarget,
    key: string,
    contentType: string,
    size: number,
  ): Promise<PresignedUploadDto> {
    const url = await getSignedUrl(
      this.require().presigner,
      new PutObjectCommand({
        Bucket: this.buckets[target],
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      {
        expiresIn: UPLOAD_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    };
  }

  presignDownload(
    target: StorageTarget,
    key: string,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.require().presigner,
      new GetObjectCommand({ Bucket: this.buckets[target], Key: key }),
      { expiresIn },
    );
  }

  async exists(target: StorageTarget, key: string): Promise<boolean> {
    try {
      await this.require().internal.send(
        new HeadObjectCommand({ Bucket: this.buckets[target], Key: key }),
      );
      return true;
    } catch (error) {
      if (error instanceof NotFound) return false;
      throw error;
    }
  }

  publicObjectUrl(target: StorageTarget, key: string): string {
    return `${this.publicUrl}/${this.buckets[target]}/${key}`;
  }

  async getBytes(target: StorageTarget, key: string): Promise<Uint8Array> {
    const { Body } = await this.require().internal.send(
      new GetObjectCommand({ Bucket: this.buckets[target], Key: key }),
    );
    if (!Body) throw new NoSuchKey({ message: key, $metadata: {} });
    return Body.transformToByteArray();
  }

  async putBytes(
    target: StorageTarget,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.require().internal.send(
      new PutObjectCommand({
        Bucket: this.buckets[target],
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  keyFromPublicUrl(target: StorageTarget, url: string): string | null {
    const prefix = `${this.publicUrl}/${this.buckets[target]}/`;
    if (!url.startsWith(prefix)) return null;
    let key: string;
    try {
      key = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
    } catch {
      return null;
    }
    return key && !key.split('/').includes('..') ? key : null;
  }

  async delete(target: StorageTarget, key: string): Promise<void> {
    await this.require().internal.send(
      new DeleteObjectCommand({ Bucket: this.buckets[target], Key: key }),
    );
  }

  private require(): StorageClients {
    if (!this.clients)
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'File storage is not configured',
      );
    return this.clients;
  }

  private async ensureBucket(
    client: S3Client,
    target: StorageTarget,
  ): Promise<void> {
    const Bucket = this.buckets[target];
    await client
      .send(new CreateBucketCommand({ Bucket }))
      .catch((error: unknown) => {
        if (
          !(error instanceof BucketAlreadyOwnedByYou) &&
          !(error instanceof BucketAlreadyExists)
        )
          throw error;
      });
    const { publicRead } = BUCKET_SETUP[target];
    if (publicRead) {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${Bucket}/*`],
              },
            ],
          }),
        }),
      );
    }
  }
}
