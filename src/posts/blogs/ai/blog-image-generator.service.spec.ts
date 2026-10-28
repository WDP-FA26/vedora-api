import { ConfigService } from '@nestjs/config';
import { AiFeature } from '../../../mongo/models.js';
import { MockImageModelV4, MockLanguageModelV4 } from 'ai/test';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AiUsageService } from '../../../ai/usage/ai-usage.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../storage/storage.service.js';
import { BlogImageGeneratorService } from './blog-image-generator.service.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const OTHER_ID = '9b2f43f5-f29f-4ee8-9c5b-357f03224003';
const PUBLIC = 'https://files.vedora.test/vedora-blogs';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

let verdict = 'allow';
const moderator = new MockLanguageModelV4({
  doGenerate: () =>
    Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify({ verdict }) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }),
});

let failImage = false;
const imageModel = new MockImageModelV4({
  doGenerate: vi.fn(() =>
    failImage
      ? Promise.reject(new Error('provider down'))
      : Promise.resolve({
          images: [PNG],
          warnings: [],
          response: {
            timestamp: new Date(),
            modelId: 'qwen/qwen-image-2.1-turbo',
            headers: undefined,
          },
        }),
  ),
});

const imageModelFactory = vi.fn(() => imageModel);
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () =>
    Object.assign(() => moderator, { imageModel: imageModelFactory }),
}));

describe('BlogImageGeneratorService', () => {
  let storage: DeepMockProxy<StorageService>;
  let aiUsage: DeepMockProxy<AiUsageService>;
  let service: BlogImageGeneratorService;

  beforeEach(() => {
    verdict = 'allow';
    failImage = false;
    vi.mocked(imageModel.doGenerate).mockClear();
    storage = mockDeep<StorageService>();
    storage.publicObjectUrl.mockImplementation(
      (_target, key) => `${PUBLIC}/${key}`,
    );
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${PUBLIC}/`) ? url.slice(PUBLIC.length + 1) : null,
    );
    aiUsage = mockDeep<AiUsageService>();
    aiUsage.consume.mockResolvedValue(true);
    aiUsage.refund.mockResolvedValue();
    service = new BlogImageGeneratorService(
      new ConfigService({ OPENROUTER_API_KEY: 'key' }),
      storage,
      aiUsage,
    );
  });

  it('uses the cheap Qwen model by default', () => {
    expect(imageModelFactory).toHaveBeenCalledWith('qwen/qwen-image-2.1-turbo');
  });

  it("stores a generated image under the user's blog folder", async () => {
    const result = await service.generate(USER_ID, 'a bowl of pho', '4:3');

    expect('url' in result && result.url).toMatch(
      new RegExp(`^${PUBLIC}/blogs/${USER_ID}/ai/[0-9a-f-]+\\.png$`),
    );
    expect(storage.putBytes).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      expect.stringMatching(`^blogs/${USER_ID}/ai/`),
      expect.any(Uint8Array),
      'image/png',
    );
    expect(imageModel.doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a bowl of pho', aspectRatio: '4:3' }),
    );
    expect(aiUsage.refund).not.toHaveBeenCalled();
  });

  it('answers with a code once the daily images are spent', async () => {
    aiUsage.consume.mockResolvedValue(false);

    await expect(service.generate(USER_ID, 'pho', '1:1')).resolves.toEqual({
      error: 'IMAGE_QUOTA_EXCEEDED',
    });
    expect(imageModel.doGenerate).not.toHaveBeenCalled();
  });

  it('refuses a flagged prompt and gives the image back', async () => {
    verdict = 'harmful';

    await expect(
      service.generate(USER_ID, 'a famous singer eating pho', '1:1'),
    ).resolves.toEqual({ error: 'IMAGE_PROMPT_REFUSED' });
    expect(imageModel.doGenerate).not.toHaveBeenCalled();
    expect(aiUsage.refund).toHaveBeenCalledWith(USER_ID, AiFeature.BLOG_IMAGE);
  });

  it('gives the image back when the provider fails', async () => {
    failImage = true;

    await expect(service.generate(USER_ID, 'pho', '1:1')).resolves.toEqual({
      error: 'IMAGE_FAILED',
    });
    expect(aiUsage.refund).toHaveBeenCalledWith(USER_ID, AiFeature.BLOG_IMAGE);
  });

  it("edits one of the user's own images", async () => {
    storage.getBytes.mockResolvedValue(Buffer.from(PNG, 'base64'));

    const result = await service.edit(
      USER_ID,
      `${PUBLIC}/blogs/${USER_ID}/photo.png`,
      'brighter',
    );

    expect(result).toHaveProperty('url');
    expect(storage.getBytes).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      `blogs/${USER_ID}/photo.png`,
    );
    const [call] = vi.mocked(imageModel.doGenerate).mock.calls;
    expect(call[0]).toMatchObject({ prompt: 'brighter' });
    expect(call[0].files).toHaveLength(1);
  });

  it.each([
    ['another user', `${PUBLIC}/blogs/${OTHER_ID}/photo.png`],
    ['another host', 'https://evil.test/blogs/photo.png'],
  ])('never edits an image from %s', async (_case, url) => {
    await expect(service.edit(USER_ID, url, 'brighter')).resolves.toEqual({
      error: 'IMAGE_NOT_OWNED',
    });
    expect(aiUsage.consume).not.toHaveBeenCalled();
    expect(storage.getBytes).not.toHaveBeenCalled();
  });
});
