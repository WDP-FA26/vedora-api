import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MuxService } from '../mux/mux.service';
import { assetReady } from './media.fixtures';
import { MediaService } from './media.service';
import { MuxWebhookController } from './mux-webhook.controller';

describe('MuxWebhookController', () => {
  const secret = 'test-webhook-secret';
  let controller: MuxWebhookController;
  let mediaService: DeepMockProxy<MediaService>;

  const body = JSON.stringify(assetReady(42));

  function sign(payload: string, key = secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', key)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return { 'mux-signature': `t=${timestamp},v1=${digest}` };
  }

  beforeEach(async () => {
    mediaService = mockDeep<MediaService>();
    const moduleRef = await Test.createTestingModule({
      controllers: [MuxWebhookController],
      providers: [
        MuxService,
        { provide: MediaService, useValue: mediaService },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MUX_TOKEN_ID: 'id',
            MUX_TOKEN_SECRET: 'secret',
            MUX_WEBHOOK_SECRET: secret,
          }),
        },
      ],
    }).compile();
    controller = moduleRef.get(MuxWebhookController);
  });

  it('passes correctly signed events to MediaService', async () => {
    await controller.receive(Buffer.from(body), sign(body));

    const [event] = mediaService.handleWebhook.mock.calls[0];
    expect(event.type).toBe('video.asset.ready');
  });

  it('rejects events signed with another secret', async () => {
    await expect(
      controller.receive(Buffer.from(body), sign(body, 'wrong-secret')),
    ).rejects.toMatchObject({ status: 400 });
    expect(mediaService.handleWebhook).not.toHaveBeenCalled();
  });
});
