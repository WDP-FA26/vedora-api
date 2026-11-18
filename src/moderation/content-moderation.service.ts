import { runtimeConfig } from '../config/runtime-config.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APICallError, type Experimental_EvaluationModel } from 'ai';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UnprocessableContentException } from '../common/exceptions/unprocessable-content.exception.js';
import { decide } from '../common/decision/decision.js';
import {
  assessContent,
  type ContentAssessment,
  isProviderBlocked,
  providerBlockedAssessment,
} from './content-decision.js';
import { toJevJpeg } from './moderation-image.js';
import { ALLOW_KEY, buildContentPolicy } from './policies/content.js';
import {
  type ContentSettingsInput,
  ModerationSettingsService,
} from './moderation-settings.service.js';

export const CONTENT_MODERATION_MODEL = Symbol('CONTENT_MODERATION_MODEL');

export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; source: Buffer }
  | { kind: 'jpeg'; source: Buffer };

const CONTENT_TIMEOUT_MS = runtimeConfig.MODERATION_CONTENT_TIMEOUT_MS;
const PROHIBITED_CONTENT_CODE = 'prohibited_content';

/** True when the model's provider refused the input itself (HTTP 400 `prohibited_content`). */
function isProviderRefusal(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400) return false;
  return error.responseBody?.includes(PROHIBITED_CONTENT_CODE) === true;
}
const MAX_TEXT_CHARS = runtimeConfig.MODERATION_MAX_TEXT_CHARS;

@Injectable()
export class ContentModerationService {
  private readonly logger = new Logger(ContentModerationService.name);

  constructor(
    @Inject(CONTENT_MODERATION_MODEL)
    private readonly model: Experimental_EvaluationModel,
    private readonly settings: ModerationSettingsService,
  ) {}

  async review(
    parts: ContentPart[],
    abortSignal: AbortSignal = new AbortController().signal,
    override?: ContentSettingsInput,
  ): Promise<ContentAssessment> {
    const policy = override ?? (await this.settings.get());
    const state: (
      string | { type: 'image_url'; image_url: { url: string } }
    )[] = [];
    for (const part of parts) {
      if (part.kind === 'text') {
        const text = part.text.trim().slice(0, MAX_TEXT_CHARS);
        if (text) state.push(text);
        continue;
      }
      const jpeg =
        part.kind === 'image' ? await toJevJpeg(part.source) : part.source;
      state.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
      });
    }
    if (state.length === 0) return assessContent(ALLOW_KEY, undefined, policy);
    try {
      const { choice, probabilities } = await decide(
        this.model,
        state,
        abortSignal,
        buildContentPolicy(policy),
        CONTENT_TIMEOUT_MS,
      );
      return assessContent(choice, probabilities, policy);
    } catch (error) {
      if (!isProviderRefusal(error)) throw error;
      this.logger.warn(
        'The model provider refused to read the content, holding it for an admin',
      );
      return providerBlockedAssessment();
    }
  }

  async requireAllowed(parts: ContentPart[]): Promise<void> {
    let assessment: ContentAssessment;
    try {
      assessment = await this.review(parts);
    } catch (error) {
      this.logger.error(`Content moderation failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Content review is unavailable, try again shortly',
      );
    }
    // Comments have no review queue, so content the provider refused to read
    // (the worst kind) is turned away like a rejection.
    if (assessment.decision !== 'reject' && !isProviderBlocked(assessment)) {
      return;
    }
    throw new UnprocessableContentException(
      'CONTENT_REJECTED',
      'This content breaks the community guidelines',
      { category: assessment.category },
    );
  }
}
