import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { CloudinaryWebhookController } from '../../../src/media/cloudinary-webhook.controller.js';
import { MediaService } from '../../../src/media/media.service.js';
import { streamBuilt } from '../../support/media.fixtures.js';

describe('CloudinaryWebhookController', () => {
  const secret = 'test-api-secret';
  let controller: CloudinaryWebhookController;
  let mediaService: DeepMockProxy<MediaService>;

  const body = JSON.stringify(streamBuilt());

  function sign(
    payload: string,
    { key = secret, algorithm = 'sha1', age = 0 } = {},
  ) {
    const timestamp = String(Math.floor(Date.now() / 1000) - age);
    const signature = createHash(algorithm)
      .update(payload + timestamp + key)
      .digest('hex');
    return { 'x-cld-timestamp': timestamp, 'x-cld-signature': signature };
  }

  async function buildController(config: Record<string, string>) {
    mediaService = mockDeep<MediaService>();
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudinaryWebhookController],
      providers: [
        CloudinaryService,
        { provide: MediaService, useValue: mediaService },
        { provide: ConfigService, useValue: new ConfigService(config) },
      ],
    }).compile();
    return moduleRef.get(CloudinaryWebhookController);
  }

  beforeEach(async () => {
    controller = await buildController({
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: secret,
    });
  });

  it.each(['sha1', 'sha256'])(
    'passes notifications signed with %s to MediaService',
    async (algorithm) => {
      await controller.receive(Buffer.from(body), sign(body, { algorithm }));

      const [notification] = mediaService.handleNotification.mock.calls[0];
      expect(notification.notification_type).toBe('eager');
    },
  );

  it('rejects notifications with 503 when Cloudinary is not configured', async () => {
    const unconfigured = await buildController({});

    await expect(
      unconfigured.receive(Buffer.from(body), sign(body)),
    ).rejects.toBeInstanceOf(FeatureUnavailableException);
    expect(mediaService.handleNotification).not.toHaveBeenCalled();
  });

  it('rejects requests missing the raw body buffer', async () => {
    await expect(
      controller.receive(undefined, sign(body)),
    ).rejects.toMatchObject({
      constructor: InvalidInputException,
      statusCode: 400,
    });
    expect(mediaService.handleNotification).not.toHaveBeenCalled();
  });

  it('rejects requests missing timestamp or signature headers', async () => {
    await expect(
      controller.receive(Buffer.from(body), { 'x-cld-signature': 'abc' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      controller.receive(Buffer.from(body), { 'x-cld-timestamp': '123' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects notifications signed with another secret', async () => {
    await expect(
      controller.receive(Buffer.from(body), sign(body, { key: 'wrong' })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mediaService.handleNotification).not.toHaveBeenCalled();
  });

  it('rejects replays of old notifications', async () => {
    await expect(
      controller.receive(Buffer.from(body), sign(body, { age: 3 * 3600 })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects signed payloads that fail notification DTO validation', async () => {
    const unexpected = JSON.stringify({ public_id: 'vedora/videos/1' });
    await expect(
      controller.receive(Buffer.from(unexpected), sign(unexpected)),
    ).rejects.toMatchObject({
      constructor: InvalidInputException,
      statusCode: 400,
    });
    expect(mediaService.handleNotification).not.toHaveBeenCalled();
  });
});
