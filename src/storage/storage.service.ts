import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignedUploadDto } from './presigned-upload.dto';

export enum StorageTarget {
  Knowledge = 'knowledge',
  Profiles = 'profiles',
  Verifications = 'verifications',
  Blogs = 'blogs',
}

/**
 * How each bucket is set up at startup: whether RustFS reports its uploads to
 * `/webhooks/storage/<target>`, and whether anyone may read its objects.
 */
const BUCKET_SETUP: Record<
  StorageTarget,
  { webhook: boolean; publicRead: boolean }
> = {
  [StorageTarget.Knowledge]: { webhook: true, publicRead: false },
  [StorageTarget.Profiles]: { webhook: true, publicRead: true },
  [StorageTarget.Verifications]: { webhook: false, publicRead: false },
  // blog images are not tracked per upload, so nothing needs the event
  [StorageTarget.Blogs]: { webhook: false, publicRead: true },
};

/** Targets whose uploads RustFS reports to `/webhooks/storage/<target>`. */
export const WebhookStorageTarget = {
  Knowledge: StorageTarget.Knowledge,
  Profiles: StorageTarget.Profiles,
} as const;
export type WebhookStorageTarget =
  (typeof WebhookStorageTarget)[keyof typeof WebhookStorageTarget];

export interface StorageEvent {
  Records?: {
    eventName?: string;
    s3?: {
      bucket?: { name?: string };
      object?: { key?: string };
    };
  }[];
}

interface StorageClients {
  internal: S3Client;
  presigner: S3Client;
}

export const UPLOAD_TTL_SECONDS = 60 * 60;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly clients: StorageClients | null;
  private readonly publicUrl: string;
  private readonly region: string;
  private readonly buckets: Record<StorageTarget, string>;
  readonly webhookToken: string;

  constructor(config: ConfigService) {
    const endpoint = config.getOrThrow<string>('STORAGE_ENDPOINT');
    const accessKeyId = config.getOrThrow<string>('STORAGE_ACCESS_KEY');
    const secretAccessKey = config.getOrThrow<string>('STORAGE_SECRET_KEY');
    this.publicUrl = config
      .getOrThrow<string>('STORAGE_PUBLIC_URL')
      .replace(/\/+$/, '');
    this.region = config.getOrThrow<string>('STORAGE_REGION');
    this.webhookToken = config.getOrThrow<string>('STORAGE_WEBHOOK_TOKEN');
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
    };
    const client = (url: string): S3Client =>
      new S3Client({
        endpoint: url,
        region: this.region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        // Otherwise presigned PUTs carry a CRC32 of an empty body, which S3
        // rejects once the browser sends the real file.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: { connectionTimeout: 3000, requestTimeout: 10_000 },
      });
    const configured =
      endpoint &&
      accessKeyId &&
      secretAccessKey &&
      this.publicUrl &&
      this.webhookToken;
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
      // the API still starts; uploads fail until RustFS is reachable
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

  /** A short-lived read URL for an object in a private bucket. */
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

  /** Public URL of an object in a public-read bucket. */
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

  async delete(target: StorageTarget, key: string): Promise<void> {
    await this.require().internal.send(
      new DeleteObjectCommand({ Bucket: this.buckets[target], Key: key }),
    );
  }

  parseEvent(target: StorageTarget, body: StorageEvent): string[] {
    if (!Array.isArray(body?.Records))
      throw new BadRequestException('Expected an S3 event');
    return body.Records.flatMap(({ eventName, s3 }) => {
      const key = s3?.object?.key;
      if (
        !eventName?.startsWith('s3:ObjectCreated:') ||
        s3?.bucket?.name !== this.buckets[target] ||
        !key
      )
        return [];
      // S3 events URL-encode keys, with "+" for spaces
      return [decodeURIComponent(key.replace(/\+/g, ' '))];
    });
  }

  private require(): StorageClients {
    if (!this.clients)
      throw new ServiceUnavailableException('File storage is not configured');
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
    const { webhook, publicRead } = BUCKET_SETUP[target];
    if (webhook) {
      await client.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket,
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                Id: `${target}-created`,
                // the webhook target named <target> in RustFS's environment
                QueueArn: `arn:rustfs:sqs:${this.region}:${target}:webhook`,
                Events: ['s3:ObjectCreated:*'],
              },
            ],
          },
        }),
      );
    }
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
