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
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { mockClient } from 'aws-sdk-client-mock';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import {
  StorageService,
  StorageTarget,
  type StorageEvent,
} from '../../../src/storage/storage.service.js';

const s3 = mockClient(S3Client);

function build(env: Record<string, unknown> = {}) {
  return new StorageService(
    new ConfigService({
      STORAGE_ENDPOINT: 'http://rustfs:9000',
      STORAGE_PUBLIC_URL: 'https://storage.vedora.vn/',
      STORAGE_ACCESS_KEY: 'access',
      STORAGE_SECRET_KEY: 'secret',
      STORAGE_WEBHOOK_TOKEN: 'webhook-token',
      STORAGE_REGION: 'us-east-1',
      STORAGE_KNOWLEDGE_BUCKET: 'vedora-knowledge',
      STORAGE_PROFILES_BUCKET: 'vedora-profiles',
      STORAGE_VERIFICATIONS_BUCKET: 'vedora-verifications',
      STORAGE_BLOGS_BUCKET: 'vedora-blogs',
      ...env,
    }),
  );
}

describe('StorageService', () => {
  beforeEach(() => s3.reset());

  describe('presignUpload', () => {
    it('signs the exact key, type and size for the public host', async () => {
      const upload = await build().presignUpload(
        StorageTarget.Knowledge,
        'knowledge/d.pdf',
        'application/pdf',
        1234,
      );
      const url = new URL(upload.url);

      expect(url.origin + url.pathname).toBe(
        'https://storage.vedora.vn/vedora-knowledge/knowledge/d.pdf',
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host',
      );
      expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
      expect(upload).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
      });
      expect(upload.expiresAt).toBeInstanceOf(Date);
    });

    it.each([
      'STORAGE_ENDPOINT',
      'STORAGE_PUBLIC_URL',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
      'STORAGE_WEBHOOK_TOKEN',
    ])('answers 503 without %s', async (name) => {
      const service = build({ [name]: '' });
      expect(service.isConfigured()).toBe(false);
      await expect(
        service.presignUpload(
          StorageTarget.Profiles,
          'profiles/a.png',
          'image/png',
          1,
        ),
      ).rejects.toBeInstanceOf(FeatureUnavailableException);
    });
  });

  describe('presignDownload', () => {
    it('signs a GET URL on the public host with the given expiry', async () => {
      const signed = await build().presignDownload(
        StorageTarget.Verifications,
        'verifications/doc.jpg',
        300,
      );
      const url = new URL(signed);

      expect(url.origin + url.pathname).toBe(
        'https://storage.vedora.vn/vedora-verifications/verifications/doc.jpg',
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });

    it('throws 503 when unconfigured', () => {
      const service = build({ STORAGE_ENDPOINT: '' });
      expect(() =>
        service.presignDownload(StorageTarget.Knowledge, 'k.pdf', 60),
      ).toThrow(FeatureUnavailableException);
    });
  });

  describe('exists', () => {
    it('returns true when HeadObject succeeds', async () => {
      s3.on(HeadObjectCommand).resolves({});
      await expect(
        build().exists(StorageTarget.Knowledge, 'knowledge/a.pdf'),
      ).resolves.toBe(true);
      expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: 'vedora-knowledge',
        Key: 'knowledge/a.pdf',
      });
    });

    it('returns false when HeadObject answers NotFound', async () => {
      s3.on(HeadObjectCommand).rejects(
        new NotFound({ message: 'missing', $metadata: {} }),
      );
      await expect(
        build().exists(StorageTarget.Knowledge, 'knowledge/missing.pdf'),
      ).resolves.toBe(false);
    });

    it('rethrows unexpected HeadObject errors', async () => {
      s3.on(HeadObjectCommand).rejects(new Error('timeout'));
      await expect(
        build().exists(StorageTarget.Knowledge, 'knowledge/a.pdf'),
      ).rejects.toThrow('timeout');
    });
  });

  describe('getBytes and putBytes', () => {
    it('reads bytes from S3 body', async () => {
      const expected = new Uint8Array([1, 2, 3, 4]);
      const body = {
        transformToByteArray: () => Promise.resolve(expected),
      } as NonNullable<GetObjectCommandOutput['Body']>;
      s3.on(GetObjectCommand).resolves({ Body: body });

      const result = await build().getBytes(StorageTarget.Blogs, 'blogs/1.png');

      expect(result).toEqual(expected);
      expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: 'vedora-blogs',
        Key: 'blogs/1.png',
      });
    });

    it('throws NoSuchKey when GetObject returns no Body', async () => {
      s3.on(GetObjectCommand).resolves({ Body: undefined });

      await expect(
        build().getBytes(StorageTarget.Blogs, 'blogs/empty.png'),
      ).rejects.toBeInstanceOf(NoSuchKey);
    });

    it('uploads bytes with Bucket, Key, Body, and ContentType', async () => {
      s3.on(PutObjectCommand).resolves({});
      const bytes = new Uint8Array([9, 8, 7]);

      await build().putBytes(
        StorageTarget.Profiles,
        'profiles/u/a.webp',
        bytes,
        'image/webp',
      );

      expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: 'vedora-profiles',
        Key: 'profiles/u/a.webp',
        Body: bytes,
        ContentType: 'image/webp',
      });
    });
  });

  describe('delete', () => {
    it('deletes an object from the target bucket', async () => {
      s3.on(DeleteObjectCommand).resolves({});

      await build().delete(StorageTarget.Knowledge, 'knowledge/old.pdf');

      expect(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: 'vedora-knowledge',
        Key: 'knowledge/old.pdf',
      });
    });
  });

  describe('publicObjectUrl and keyFromPublicUrl', () => {
    it('serves profile images from the public bucket URL', () => {
      expect(
        build().publicObjectUrl(
          StorageTarget.Profiles,
          'profiles/u/avatar/a.png',
        ),
      ).toBe(
        'https://storage.vedora.vn/vedora-profiles/profiles/u/avatar/a.png',
      );
    });

    it('extracts and decodes keys from matching public URLs', () => {
      const service = build();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://storage.vedora.vn/vedora-blogs/blogs/my%20pic.png?v=1#top',
        ),
      ).toBe('blogs/my pic.png');
    });

    it('returns null for mismatched bucket/origin, empty key, traversal, or malformed encoding', () => {
      const service = build();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://other.host/vedora-blogs/a.png',
        ),
      ).toBeNull();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://storage.vedora.vn/vedora-profiles/a.png',
        ),
      ).toBeNull();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://storage.vedora.vn/vedora-blogs/',
        ),
      ).toBeNull();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://storage.vedora.vn/vedora-blogs/blogs/../secret.txt',
        ),
      ).toBeNull();
      expect(
        service.keyFromPublicUrl(
          StorageTarget.Blogs,
          'https://storage.vedora.vn/vedora-blogs/%E0%A4%A',
        ),
      ).toBeNull();
    });
  });

  describe('onModuleInit', () => {
    it('creates the buckets, binds upload events and opens only profiles and blogs for reading', async () => {
      s3.on(CreateBucketCommand)
        .rejectsOnce(
          new BucketAlreadyOwnedByYou({ message: 'exists', $metadata: {} }),
        )
        .rejectsOnce(
          new BucketAlreadyExists({ message: 'exists', $metadata: {} }),
        )
        .resolves({})
        .on(PutBucketNotificationConfigurationCommand)
        .resolves({})
        .on(PutBucketPolicyCommand)
        .resolves({});

      await build().onModuleInit();

      expect(
        s3
          .commandCalls(PutBucketNotificationConfigurationCommand)
          .map(({ args }) => [
            args[0].input.Bucket,
            args[0].input.NotificationConfiguration?.QueueConfigurations?.[0]
              .QueueArn,
          ]),
      ).toEqual([
        ['vedora-knowledge', 'arn:rustfs:sqs:us-east-1:knowledge:webhook'],
        ['vedora-profiles', 'arn:rustfs:sqs:us-east-1:profiles:webhook'],
      ]);
      const policies = s3.commandCalls(PutBucketPolicyCommand);
      expect(policies.map(({ args }) => args[0].input.Bucket).sort()).toEqual([
        'vedora-blogs',
        'vedora-profiles',
      ]);
      const profiles = policies.find(
        ({ args }) => args[0].input.Bucket === 'vedora-profiles',
      )!;
      expect(JSON.parse(profiles.args[0].input.Policy!)).toMatchObject({
        Statement: [
          {
            Action: ['s3:GetObject'],
            Resource: ['arn:aws:s3:::vedora-profiles/*'],
          },
        ],
      });
    });

    it('still starts when RustFS is unreachable', async () => {
      s3.on(CreateBucketCommand).rejects(new Error('ECONNREFUSED'));
      await expect(build().onModuleInit()).resolves.toBeUndefined();
    });

    it('skips bucket setup when storage is not configured', async () => {
      await expect(
        build({ STORAGE_ACCESS_KEY: '' }).onModuleInit(),
      ).resolves.toBeUndefined();
      expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
    });
  });

  describe('parseEvent', () => {
    const event = (
      bucket: string,
      key: string,
      eventName = 's3:ObjectCreated:Put',
    ) => ({
      EventName: eventName,
      Records: [
        {
          eventName,
          s3: {
            bucket: { name: bucket },
            object: { key },
          },
        },
      ],
    });

    it('returns the decoded keys stored in the bucket', () => {
      expect(
        build().parseEvent(
          StorageTarget.Knowledge,
          event('vedora-knowledge', 'knowledge%2Fmy+file.pdf'),
        ),
      ).toEqual(['knowledge/my file.pdf']);
    });

    it("ignores other buckets' objects, non-create events, and incomplete records", () => {
      const service = build();
      expect(
        service.parseEvent(
          StorageTarget.Profiles,
          event('vedora-knowledge', 'knowledge%2Fd.pdf'),
        ),
      ).toEqual([]);
      expect(
        service.parseEvent(
          StorageTarget.Knowledge,
          event(
            'vedora-knowledge',
            'knowledge%2Fd.pdf',
            's3:ObjectRemoved:Delete',
          ),
        ),
      ).toEqual([]);
      expect(
        service.parseEvent(StorageTarget.Knowledge, {
          Records: [
            {},
            {
              eventName: 's3:ObjectCreated:Put',
              s3: { bucket: { name: 'vedora-knowledge' }, object: {} },
            },
          ],
        }),
      ).toEqual([]);
    });

    it('rejects bodies that are not S3 events', () => {
      expect(() => build().parseEvent(StorageTarget.Knowledge, {})).toThrow(
        InvalidInputException,
      );
      expect(() =>
        build().parseEvent(
          StorageTarget.Knowledge,
          null as unknown as StorageEvent,
        ),
      ).toThrow(InvalidInputException);
    });
  });
});
