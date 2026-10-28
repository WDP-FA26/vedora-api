import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { ConfigService } from '@nestjs/config';
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { StorageService, StorageTarget } from './storage.service.js';

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
    });

    it.each([
      'STORAGE_ENDPOINT',
      'STORAGE_PUBLIC_URL',
      'STORAGE_ACCESS_KEY',
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

  it('serves profile images from the public bucket URL', () => {
    expect(
      build().publicObjectUrl(
        StorageTarget.Profiles,
        'profiles/u/avatar/a.png',
      ),
    ).toBe('https://storage.vedora.vn/vedora-profiles/profiles/u/avatar/a.png');
  });

  describe('onModuleInit', () => {
    it('creates the buckets, binds upload events and opens only profiles and blogs for reading', async () => {
      s3.on(CreateBucketCommand)
        .rejects(
          new BucketAlreadyOwnedByYou({ message: 'exists', $metadata: {} }),
        )
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

    it("ignores other buckets' objects and non-create events", () => {
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
    });

    it('rejects bodies that are not S3 events', () => {
      expect(() => build().parseEvent(StorageTarget.Knowledge, {})).toThrow(
        InvalidInputException,
      );
    });
  });
});
