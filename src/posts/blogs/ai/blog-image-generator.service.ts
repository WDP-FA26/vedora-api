import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiFeature } from '../../../mongo/models.js';
import {
  type Experimental_EvaluationModel,
  generateImage,
  type ImageModel,
} from 'ai';
import { randomUUID } from 'node:crypto';
import { MODERATION_MODEL } from '../../../ai/guardrails/guardrail.js';
import { decide } from '../../../common/decision/decision.js';
import { DEFAULT_IMAGE_MODEL, imageModel } from '../../../ai/openrouter.js';
import { AiUsageService } from '../../../ai/usage/ai-usage.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../storage/storage.service.js';
import { BLOG_ASSISTANT_POLICY } from '../../../ai/guardrails/policies/blog-assistant.js';
import { blogRefusal } from './blog-assistant.moderation.js';

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

@Injectable()
export class BlogImageGeneratorService {
  private readonly logger = new Logger(BlogImageGeneratorService.name);
  private readonly imageModel: ImageModel;

  constructor(
    configService: ConfigService,
    @Inject(MODERATION_MODEL)
    private readonly moderator: Experimental_EvaluationModel,
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

  async edit(
    userId: string,
    imageUrl: string,
    instruction: string,
    abortSignal?: AbortSignal,
  ): Promise<ImageResult> {
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
      const { choice: verdict } = await decide(
        this.moderator,
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
