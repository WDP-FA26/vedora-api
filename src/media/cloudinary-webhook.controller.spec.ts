import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { CloudinaryWebhookController } from './cloudinary-webhook.controller.js';
import { streamBuilt } from './media.fixtures.js';
import { MediaService } from './media.service.js';

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

  beforeEach(async () => {
    mediaService = mockDeep<MediaService>();
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudinaryWebhookController],
      providers: [
        CloudinaryService,
        { provide: MediaService, useValue: mediaService },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CLOUDINARY_CLOUD_NAME: 'demo',
            CLOUDINARY_API_KEY: 'key',
            CLOUDINARY_API_SECRET: secret,
          }),
        },
      ],
    }).compile();
    controller = moduleRef.get(CloudinaryWebhookController);
  });

  it.each(['sha1', 'sha256'])(
    'passes notifications signed with %s to MediaService',
    async (algorithm) => {
      await controller.receive(Buffer.from(body), sign(body, { algorithm }));

      const [notification] = mediaService.handleNotification.mock.calls[0];
      expect(notification.notification_type).toBe('eager');
    },
  );

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
});
