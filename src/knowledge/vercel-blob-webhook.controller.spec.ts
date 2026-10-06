import { BadRequestException } from '@nestjs/common';
import { VercelBlobWebhookController } from './vercel-blob-webhook.controller';
import { ProfilesService } from '../profiles/profiles.service';

describe('VercelBlobWebhookController', () => {
  const profiles = { handleImageCallback: vi.fn() };
  const controller = new VercelBlobWebhookController(
    profiles as unknown as ProfilesService,
  );
  const request = {} as never;

  beforeEach(() => vi.clearAllMocks());

  it('routes profile uploads to the profile callback verifier', async () => {
    const body = {
      type: 'blob.upload-completed',
      payload: { blob: { pathname: 'profiles/user/avatar/image.webp' } },
    } as never;
    await controller.receive(body, request);
    expect(profiles.handleImageCallback).toHaveBeenCalledWith(body, request);
  });

  it('rejects paths outside profiles', async () => {
    await expect(
      controller.receive(
        {
          type: 'blob.upload-completed',
          payload: { blob: { pathname: 'other/image.webp' } },
        } as never,
        request,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(profiles.handleImageCallback).not.toHaveBeenCalled();
  });
});
