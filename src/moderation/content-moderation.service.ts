import { runtimeConfig } from '../config/runtime-config.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  APICallError,
  generateText,
  InvalidResponseDataError,
  type LanguageModel,
  Output,
  RetryError,
} from 'ai';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UnprocessableContentException } from '../common/exceptions/unprocessable-content.exception.js';
import { PromptCache } from '../ai/prompt-cache.js';
import type { ModerationEvidence } from '../mongo/models.js';
import {
  type EvidenceSources,
  type EvidenceText,
  reviewInstructions,
  reviewMessageParts,
  reviewOutput,
  verifyEvidence,
} from './content-evidence.js';
import {
  type ContentPolicySettings,
  withReservedChoices,
} from './policies/content.js';
import { ModerationSettingsService } from './moderation-settings.service.js';

export const CONTENT_MODERATION_MODEL = Symbol('CONTENT_MODERATION_MODEL');

/** The reviewer model and the id it is billed and stored under. */
export interface ModerationModel {
  id: string;
  model: Exclude<LanguageModel, string>;
}

const TIMEOUT_MS = runtimeConfig.MODERATION_CONTENT_TIMEOUT_MS;
const MAX_RETRIES = runtimeConfig.AI_DECISION_MAX_RETRIES;
const MAX_TEXT_CHARS = runtimeConfig.MODERATION_MAX_TEXT_CHARS;
/** Room for low-effort thinking plus the rating and its evidence. */
const MAX_OUTPUT_TOKENS = runtimeConfig.MODERATION_CONTENT_MAX_OUTPUT_TOKENS;
const MAX_RISK = 3;
const SESSION_ID = 'vedora-content-moderation';
/** The highest risk level: a clear violation. */
const HIGH_RISK = 3;
/** The risk level from which an admin looks before the content is published. */
const MEDIUM_RISK = 2;
const PROHIBITED_CONTENT_CODE = 'prohibited_content';

export type ContentDecision = 'publish' | 'review' | 'reject';

/**
 * Verdict of content the model could not rate because it or its provider
 * refused to read it. It is not a policy category, so admins see it as is.
 */
export const PROVIDER_BLOCKED_KEY = 'provider_blocked';
/** Verdict of content the model could not rate because the call failed. */
export const MODERATION_FAILED_KEY = 'moderation_failed';

export interface ContentAssessment {
  decision: ContentDecision;
  /** The category it breaks worst; null when it breaks none. */
  category: string | null;
  /** 0 (no risk) to 3 (a clear violation); null when the model gave none. */
  riskLevel: number | null;
  /** Null only for empty content, which is never sent to the model. */
  evidence: ModerationEvidence | null;
}

/**
 * Where a risk level sends content. A high-risk rating the model cannot back
 * with checked evidence goes to an admin instead of being rejected.
 */
export function decisionFor(
  riskLevel: number,
  verifiedEvidence: number,
): ContentDecision {
  if (riskLevel >= HIGH_RISK && verifiedEvidence > 0) return 'reject';
  if (riskLevel >= MEDIUM_RISK) return 'review';
  return 'publish';
}

function unrated(
  category: string,
  status: ModerationEvidence['status'],
  model: string,
): ContentAssessment {
  return {
    decision: 'review',
    category,
    riskLevel: null,
    evidence: {
      status,
      summary: null,
      items: [],
      dropped: 0,
      model,
      createdAt: new Date(),
    },
  };
}

/** Content the model refused to read: held for an admin. */
export function providerBlockedAssessment(model: string): ContentAssessment {
  return unrated(PROVIDER_BLOCKED_KEY, 'REFUSED', model);
}

/** Content the model could not rate (an error, a timeout): held for an admin. */
export function failedAssessment(model: string): ContentAssessment {
  return unrated(MODERATION_FAILED_KEY, 'FAILED', model);
}

export function isProviderBlocked(assessment: ContentAssessment): boolean {
  return assessment.category === PROVIDER_BLOCKED_KEY;
}

/** True when the model's provider refused the input itself (HTTP 400 `prohibited_content`). */
function isProviderRefusal(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    if (error.statusCode !== 400) return false;
    return error.responseBody?.includes(PROHIBITED_CONTENT_CODE) === true;
  }
  if (RetryError.isInstance(error)) {
    return error.errors.some((attempt) => isProviderRefusal(attempt));
  }
  return false;
}

/** The texts, trimmed and cut to the length the model reads; empty ones dropped. */
function readableSources(sources: EvidenceSources): EvidenceSources {
  const texts: EvidenceText[] = [];
  for (const text of sources.texts) {
    const trimmed = text.text.trim().slice(0, MAX_TEXT_CHARS);
    if (trimmed.length > 0) texts.push({ ...text, text: trimmed });
  }
  return { texts, images: sources.images };
}

function categoryKeys(policy: ContentPolicySettings): [string, ...string[]] {
  const [first, ...rest] = policy.choices.map((choice) => choice.key);
  if (first === undefined) {
    throw new Error('The moderation policy has no categories');
  }
  return [first, ...rest];
}

/**
 * Rates content in one call to the reviewer model (Claude Haiku through
 * OpenRouter): a risk level, the category it breaks and the parts that break
 * it, checked against the content before anyone sees them.
 */
@Injectable()
export class ContentModerationService {
  private readonly logger = new Logger(ContentModerationService.name);

  constructor(
    @Inject(CONTENT_MODERATION_MODEL)
    private readonly reviewer: ModerationModel,
    private readonly settings: ModerationSettingsService,
  ) {}

  /** The model id stored with every verdict. */
  get modelId(): string {
    return this.reviewer.id;
  }

  /**
   * Throws when the model does not answer or answers out of range. Content
   * the model or its provider refuses to read is held for an admin.
   */
  async review(
    sources: EvidenceSources,
    draftPolicy?: ContentPolicySettings,
  ): Promise<ContentAssessment> {
    const policy = draftPolicy
      ? { ...draftPolicy, choices: withReservedChoices(draftPolicy.choices) }
      : await this.settings.get();
    const readable = readableSources(sources);
    if (readable.texts.length === 0 && readable.images.length === 0) {
      return {
        decision: 'publish',
        category: null,
        riskLevel: 0,
        evidence: null,
      };
    }
    let result;
    try {
      result = await generateText({
        model: this.reviewer.model,
        maxRetries: MAX_RETRIES,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        ...PromptCache.singleTurn({
          session: SESSION_ID,
          instructions: reviewInstructions(policy),
          enabled: draftPolicy === undefined,
        }),
        messages: [{ role: 'user', content: reviewMessageParts(readable) }],
        output: Output.object({
          schema: reviewOutput(categoryKeys(policy)),
          name: 'content_review',
        }),
      });
    } catch (error) {
      if (!isProviderRefusal(error)) throw error;
      this.logger.warn(
        'The model provider refused to read the content, holding it for an admin',
      );
      return providerBlockedAssessment(this.reviewer.id);
    }
    if (result.finishReason === 'content-filter') {
      this.logger.warn(
        'The model refused to rate the content, holding it for an admin',
      );
      return providerBlockedAssessment(this.reviewer.id);
    }
    const output = result.output;
    if (output.riskLevel < 0 || output.riskLevel > MAX_RISK) {
      throw new InvalidResponseDataError({
        data: output,
        message: `The reviewer model answered risk level ${output.riskLevel}`,
      });
    }
    const { items, dropped } = verifyEvidence(output.evidence, readable);
    let category: string | null = null;
    if (output.riskLevel > 0) {
      category = output.category ?? items.at(0)?.category ?? null;
    }
    return {
      decision: decisionFor(output.riskLevel, items.length),
      category,
      riskLevel: output.riskLevel,
      evidence: {
        status: 'READY',
        summary: output.summary.trim(),
        items,
        dropped,
        model: this.reviewer.id,
        createdAt: new Date(),
      },
    };
  }

  /**
   * For content with no review queue (comments, generated summaries): a high
   * risk or content the model refused to read is turned away.
   */
  async requireAllowed(text: string): Promise<void> {
    let assessment: ContentAssessment;
    try {
      assessment = await this.review({
        texts: [{ field: 'body', mediaId: null, text }],
        images: [],
      });
    } catch (error) {
      this.logger.error(`Content moderation failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Content review is unavailable, try again shortly',
      );
    }
    const highRisk = (assessment.riskLevel ?? 0) >= HIGH_RISK;
    if (!highRisk && !isProviderBlocked(assessment)) return;
    const reasonTexts = await this.settings.reasonTexts();
    const findings = (assessment.evidence?.items ?? []).map((item) => ({
      quote: item.quote,
      reason: item.reason,
      reasonText: reasonTexts.get(item.category) ?? null,
    }));
    throw new UnprocessableContentException(
      'CONTENT_REJECTED',
      'This content breaks the community guidelines',
      {
        category: assessment.category,
        reasonText: reasonTexts.get(assessment.category ?? '') ?? null,
        findings,
      },
    );
  }
}
