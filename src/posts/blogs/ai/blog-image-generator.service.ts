import { runtimeConfig } from '@src/config/runtime-config.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiFeature } from '@src/mongo/models.js';
import { generateImage, type ImageModel } from 'ai';
import { randomUUID } from 'node:crypto';
import { MODERATION_MODEL } from '@src/ai/guardrails/guardrail.js';
import { decide, type DecisionModel } from '@src/common/decision/decision.js';
import { DEFAULT_IMAGE_MODEL } from '@src/ai/openrouter.js';
import { aiModels } from '@src/ai/provider.js';
import { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';
import { StorageService, StorageTarget } from '@src/storage/storage.service.js';
import { BLOG_ASSISTANT_POLICY } from '@src/ai/guardrails/policies/blog-assistant.js';
import { blogRefusal } from './blog-assistant.moderation.js';

const SUPPORTED_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9'] as const;
export type ImageAspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

export function isImageAspectRatio(value: string): value is ImageAspectRatio {
  return SUPPORTED_ASPECT_RATIOS.some((ratio) => ratio === value);
}

/** Runtime settings reject any other ratio, so the filter drops nothing. */
export const IMAGE_ASPECT_RATIOS =
  runtimeConfig.AI_IMAGE_ALLOWED_ASPECT_RATIOS.split(',')
    .map((value) => value.trim())
    .filter(isImageAspectRatio);

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
    private readonly moderator: DecisionModel,
    private readonly storage: StorageService,
    private readonly usage: AiUsageService,
    costs: AiCostTransportService,
  ) {
    const modelId = configService.get<string>(
      'OPENROUTER_IMAGE_MODEL',
      DEFAULT_IMAGE_MODEL,
    );
    this.imageModel = aiModels(configService).image(modelId, {
      fetch: costs.forModel(modelId),
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
        maxRetries: runtimeConfig.AI_IMAGE_MAX_RETRIES,
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
        maxRetries: runtimeConfig.AI_IMAGE_MAX_RETRIES,
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
    const ticket = await this.usage.consume(userId, AiFeature.BLOG_IMAGE, {
      input: { prompt },
      prompt,
    });
    if (!ticket) return { error: 'IMAGE_QUOTA_EXCEEDED' };
    try {
      const { choice: verdict } = await decide(
        this.moderator,
        prompt,
        abortSignal ?? new AbortController().signal,
        BLOG_ASSISTANT_POLICY,
      );
      if (blogRefusal(verdict)) {
        this.logger.warn(`Image prompt moderation answered ${verdict}`);
        await this.usage.refund(ticket);
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
      await this.usage.complete(ticket);
      return { url: this.storage.publicObjectUrl(StorageTarget.Blogs, key) };
    } catch (error) {
      this.logger.error(`Image generation failed: ${String(error)}`);
      await this.usage.refund(ticket).catch(() => undefined);
      return { error: 'IMAGE_FAILED' };
    }
  }
}
