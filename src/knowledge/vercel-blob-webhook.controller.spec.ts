import { BadRequestException } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { VercelBlobWebhookController } from './vercel-blob-webhook.controller';
import { ProfilesService } from '../profiles/profiles.service';

describe('VercelBlobWebhookController', () => {
  const knowledge = { handleCallback: vi.fn() };
  const profiles = { handleImageCallback: vi.fn() };
  const controller = new VercelBlobWebhookController(
    knowledge as unknown as KnowledgeService,
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
    expect(knowledge.handleCallback).not.toHaveBeenCalled();
  });

  it('routes knowledge uploads to the knowledge callback verifier', async () => {
    const body = {
      type: 'blob.upload-completed',
      payload: { blob: { pathname: 'knowledge/document.pdf' } },
    } as never;
    await controller.receive(body, request);
    expect(knowledge.handleCallback).toHaveBeenCalledWith(body, request);
    expect(profiles.handleImageCallback).not.toHaveBeenCalled();
  });

  it('rejects paths outside the supported namespaces', async () => {
    await expect(
      controller.receive(
        {
          type: 'blob.upload-completed',
          payload: { blob: { pathname: 'other/image.webp' } },
        } as never,
        request,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(knowledge.handleCallback).not.toHaveBeenCalled();
    expect(profiles.handleImageCallback).not.toHaveBeenCalled();
  });
});
