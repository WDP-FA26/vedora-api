import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { FakeModel } from '@nestjs/ai/testing';
import { ConfigService } from '@nestjs/config';
import { MockImageModelV4 } from 'ai/test';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import { StorageService, StorageTarget } from '@src/storage/storage.service.js';
import { BlogImageGeneratorService } from '@src/posts/blogs/ai/blog-image-generator.service.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const OTHER_ID = '9b2f43f5-f29f-4ee8-9c5b-357f03224003';
const PUBLIC = 'https://files.vedora.test/vedora-blogs';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A noisy 640x480 PNG, sized like a model image, that WebP shrinks a lot. */
function samplePng(): Uint8Array {
  const binary = typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg';
  const result = spawnSync(
    binary,
    [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x480',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return new Uint8Array(result.stdout);
}
const GENERATED = samplePng();

const webp = vi.hoisted(() => ({ fail: false }));
vi.mock('@src/common/ffmpeg/webp.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@src/common/ffmpeg/webp.js')>();
  return {
    toWebp: (source: Uint8Array) =>
      webp.fail
        ? Promise.reject(new Error('ffmpeg missing'))
        : actual.toWebp(source),
  };
});

let generated: Uint8Array | string = GENERATED;
let verdict = 'allow';
const moderator = new FakeModel(() => ({ object: { choice: verdict } }));

let failImage = false;
const imageModel = new MockImageModelV4({
  doGenerate: vi.fn(() =>
    failImage
      ? Promise.reject(new Error('provider down'))
      : Promise.resolve({
          images: [generated],
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
  createOpenRouter: () => ({ imageModel: imageModelFactory }),
}));

describe('BlogImageGeneratorService', () => {
  let storage: DeepMockProxy<StorageService>;
  let aiUsage: DeepMockProxy<AiUsageService>;
  let service: BlogImageGeneratorService;

  beforeEach(() => {
    verdict = 'allow';
    failImage = false;
    webp.fail = false;
    generated = GENERATED;
    vi.mocked(imageModel.doGenerate).mockClear();
    moderator.calls.length = 0;
    storage = mockDeep<StorageService>();
    storage.publicObjectUrl.mockImplementation(
      (_target, key) => `${PUBLIC}/${key}`,
    );
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${PUBLIC}/`) ? url.slice(PUBLIC.length + 1) : null,
    );
    aiUsage = mockDeep<AiUsageService>();
    aiUsage.consume.mockResolvedValue({
      id: 'ticket',
      token: 'lease',
      hash: 'hash',
    });
    aiUsage.refund.mockResolvedValue();
    aiUsage.complete.mockResolvedValue();
    service = new BlogImageGeneratorService(
      new ConfigService({ OPENROUTER_API_KEY: 'key' }),
      moderator,
      storage,
      aiUsage,
      mockDeep<AiCostTransportService>(),
    );
  });

  it('uses the cheap Qwen model by default', () => {
    expect(imageModelFactory).toHaveBeenCalledWith('qwen/qwen-image-2.1-turbo');
  });

  it("stores a generated image under the user's blog folder as WebP", async () => {
    const result = await service.generate(USER_ID, 'a bowl of pho', '4:3');

    expect('url' in result && result.url).toMatch(
      new RegExp(`^${PUBLIC}/blogs/${USER_ID}/ai/[0-9a-f-]+\\.webp$`),
    );
    expect(storage.putBytes).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      expect.stringMatching(`^blogs/${USER_ID}/ai/`),
      expect.any(Uint8Array),
      'image/webp',
    );
    const stored = Buffer.from(storage.putBytes.mock.calls[0][2]);
    expect(stored.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(stored.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(stored.byteLength).toBeLessThan(GENERATED.byteLength / 2);
    expect(imageModel.doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a bowl of pho', aspectRatio: '4:3' }),
    );
    expect(aiUsage.refund).not.toHaveBeenCalled();
  });

  it('keeps the PNG when WebP conversion fails', async () => {
    webp.fail = true;

    const result = await service.generate(USER_ID, 'pho', '1:1');

    expect('url' in result && result.url).toMatch(/\.png$/);
    expect(storage.putBytes).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      expect.stringMatching(/\.png$/),
      GENERATED,
      'image/png',
    );
    expect(aiUsage.complete).toHaveBeenCalled();
  });

  it('keeps the PNG when WebP would not be smaller', async () => {
    generated = PNG;

    const result = await service.generate(USER_ID, 'pho', '1:1');

    expect('url' in result && result.url).toMatch(/\.png$/);
    expect(storage.putBytes).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      expect.stringMatching(/\.png$/),
      expect.any(Uint8Array),
      'image/png',
    );
  });

  it('answers with a code once the daily images are spent', async () => {
    aiUsage.consume.mockResolvedValue(null);

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
    expect(moderator.lastCall?.lastUserMessage).toBe(
      'Message:\n<message>a famous singer eating pho</message>',
    );
    expect(imageModel.doGenerate).not.toHaveBeenCalled();
    expect(aiUsage.refund).toHaveBeenCalledWith({
      id: 'ticket',
      token: 'lease',
      hash: 'hash',
    });
  });

  it('gives the image back when the provider fails', async () => {
    failImage = true;

    await expect(service.generate(USER_ID, 'pho', '1:1')).resolves.toEqual({
      error: 'IMAGE_FAILED',
    });
    expect(aiUsage.refund).toHaveBeenCalledWith({
      id: 'ticket',
      token: 'lease',
      hash: 'hash',
    });
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
