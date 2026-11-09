import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Experimental_EvaluationModel } from 'ai';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UnprocessableContentException } from '../common/exceptions/unprocessable-content.exception.js';
import { decide } from '../common/decision/decision.js';
import { assessContent, type ContentAssessment } from './content-decision.js';
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

const CONTENT_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 30_000;

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
    const { choice, probabilities } = await decide(
      this.model,
      state,
      abortSignal,
      buildContentPolicy(policy),
      CONTENT_TIMEOUT_MS,
    );
    return assessContent(choice, probabilities, policy);
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
    if (assessment.decision !== 'reject') return;
    throw new UnprocessableContentException(
      'CONTENT_REJECTED',
      'This content breaks the community guidelines',
      { category: assessment.category },
    );
  }
}
