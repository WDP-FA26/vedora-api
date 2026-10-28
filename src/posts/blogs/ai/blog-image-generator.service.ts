import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiFeature } from '../../../mongo/models.js';
import { generateImage, type ImageModel, type LanguageModel } from 'ai';
import { randomUUID } from 'node:crypto';
import { moderateWithRetry } from '../../../ai/moderation/moderation.js';
import {
  chatModel,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODERATION_MODEL,
  imageModel,
} from '../../../ai/openrouter.js';
import { AiUsageService } from '../../../ai/usage/ai-usage.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../storage/storage.service.js';
import {
  BLOG_ASSISTANT_POLICY,
  blogRefusal,
} from './blog-assistant.moderation.js';

export const IMAGE_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9'] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const IMAGE_ERRORS = [
  'IMAGE_QUOTA_EXCEEDED',
  'IMAGE_PROMPT_REFUSED',
  'IMAGE_NOT_OWNED',
  'IMAGE_FAILED',
] as const;
export type ImageError = (typeof IMAGE_ERRORS)[number];
export type ImageResult = { url: string } | { error: ImageError };

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Generates and edits blog illustrations with a cheap OpenRouter image model,
 * then stores them beside the user's uploaded blog images. Each image counts
 * against the daily `BLOG_IMAGE` allowance, given back when nothing is made.
 * Failures come back as an error code, never thrown, so the agent can tell the
 * user what happened.
 */
@Injectable()
export class BlogImageGeneratorService {
  private readonly logger = new Logger(BlogImageGeneratorService.name);
  private readonly imageModel: ImageModel;
  private readonly moderationModel: LanguageModel;

  constructor(
    configService: ConfigService,
    private readonly storage: StorageService,
    private readonly usage: AiUsageService,
  ) {
    const apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.imageModel = imageModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_IMAGE_MODEL',
        DEFAULT_IMAGE_MODEL,
      ),
    });
    this.moderationModel = chatModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        DEFAULT_MODERATION_MODEL,
      ),
      reasoningEffort: 'low',
    });
  }

  generate(
    userId: string,
    prompt: string,
    aspectRatio: ImageAspectRatio,
    abortSignal?: AbortSignal,
  ): Promise<ImageResult> {
    return this.run(userId, prompt, abortSignal, () =>
      generateImage({
        model: this.imageModel,
        prompt,
        aspectRatio,
        maxRetries: 1,
        abortSignal,
      }),
    );
  }

  /** Edits an image the user already has in the blogs bucket. */
  async edit(
    userId: string,
    imageUrl: string,
    instruction: string,
    abortSignal?: AbortSignal,
  ): Promise<ImageResult> {
    // only the user's own blog images: never another user's, never a URL
    // the server would have to fetch from elsewhere
    const key = this.storage.keyFromPublicUrl(StorageTarget.Blogs, imageUrl);
    if (!key?.startsWith(`blogs/${userId}/`))
      return { error: 'IMAGE_NOT_OWNED' };
    return this.run(userId, instruction, abortSignal, async () => {
      const source = await this.storage.getBytes(StorageTarget.Blogs, key);
      return generateImage({
        model: this.imageModel,
        prompt: { images: [source], text: instruction },
        maxRetries: 1,
        abortSignal,
      });
    });
  }

  private async run(
    userId: string,
    prompt: string,
    abortSignal: AbortSignal | undefined,
    produce: () => ReturnType<typeof generateImage>,
  ): Promise<ImageResult> {
    if (!(await this.usage.consume(userId, AiFeature.BLOG_IMAGE)))
      return { error: 'IMAGE_QUOTA_EXCEEDED' };
    try {
      const verdict = await moderateWithRetry(
        this.moderationModel,
        prompt,
        abortSignal ?? new AbortController().signal,
        BLOG_ASSISTANT_POLICY,
      );
      if (blogRefusal(verdict)) {
        this.logger.warn(`Image prompt moderation answered ${verdict}`);
        await this.usage.refund(userId, AiFeature.BLOG_IMAGE);
        return { error: 'IMAGE_PROMPT_REFUSED' };
      }
      const { image } = await produce();
      const extension = EXTENSIONS[image.mediaType] ?? 'png';
      const key = `blogs/${userId}/ai/${randomUUID()}.${extension}`;
      await this.storage.putBytes(
        StorageTarget.Blogs,
        key,
        image.uint8Array,
        EXTENSIONS[image.mediaType] ? image.mediaType : 'image/png',
      );
      return { url: this.storage.publicObjectUrl(StorageTarget.Blogs, key) };
    } catch (error) {
      this.logger.error(`Image generation failed: ${String(error)}`);
      await this.usage
        .refund(userId, AiFeature.BLOG_IMAGE)
        .catch(() => undefined);
      return { error: 'IMAGE_FAILED' };
    }
  }
}
