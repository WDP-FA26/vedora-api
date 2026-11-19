import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText, type LanguageModel, Output, RetryError } from 'ai';
import { runtimeConfig } from '../config/runtime-config.js';
import type { ModerationEvidence } from '../mongo/models.js';
import {
  evidenceInstructions,
  evidenceMessageParts,
  evidenceOutput,
  type EvidenceSources,
  verifyEvidence,
} from './content-evidence.js';
import { isProviderRefusal } from './content-moderation.service.js';
import { ModerationSettingsService } from './moderation-settings.service.js';

export const MODERATION_EVIDENCE_MODEL = Symbol('MODERATION_EVIDENCE_MODEL');

/** The explainer model and the id it is billed and stored under. */
export interface EvidenceModel {
  id: string;
  model: Exclude<LanguageModel, string>;
}

const TIMEOUT_MS = runtimeConfig.MODERATION_EVIDENCE_TIMEOUT_MS;
const MAX_RETRIES = runtimeConfig.AI_DECISION_MAX_RETRIES;

/** True when any attempt failed because the provider refused to read the content. */
function wasRefused(error: unknown): boolean {
  if (isProviderRefusal(error)) return true;
  if (RetryError.isInstance(error)) {
    return error.errors.some((attempt) => isProviderRefusal(attempt));
  }
  return false;
}

/**
 * The second look at flagged content: a chat model that reads the same text
 * and images and points at the parts that break the policy. It only explains;
 * the verdict stays the classifier's and the admin's.
 */
@Injectable()
export class ContentEvidenceService {
  private readonly logger = new Logger(ContentEvidenceService.name);

  constructor(
    @Inject(MODERATION_EVIDENCE_MODEL)
    private readonly explainer: EvidenceModel,
    private readonly settings: ModerationSettingsService,
  ) {}

  /**
   * Never throws: a failure to load the post's text and pictures, to read the
   * policy or to get an answer comes back as FAILED (or REFUSED), so the admin
   * sees it instead of an explanation that never arrives.
   */
  async explain(
    loadSources: () => Promise<EvidenceSources>,
  ): Promise<ModerationEvidence> {
    const base = { model: this.explainer.id, createdAt: new Date() };
    try {
      const [policy, sources] = await Promise.all([
        this.settings.get(),
        loadSources(),
      ]);
      const { output: object } = await generateText({
        model: this.explainer.model,
        temperature: 0,
        maxRetries: MAX_RETRIES,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        system: evidenceInstructions(policy),
        messages: [{ role: 'user', content: evidenceMessageParts(sources) }],
        output: Output.object({
          schema: evidenceOutput,
          name: 'moderation_evidence',
        }),
      });
      const categories = new Set(policy.choices.map((choice) => choice.key));
      const { items, dropped } = verifyEvidence(object, sources, categories);
      let category: string | null = null;
      if (object.category !== null && categories.has(object.category)) {
        category = object.category;
      }
      return {
        ...base,
        status: 'READY',
        decision: object.decision,
        category,
        summary: object.summary.trim(),
        items,
        dropped,
      };
    } catch (error) {
      const status = wasRefused(error) ? 'REFUSED' : 'FAILED';
      this.logger.warn(
        `Explaining flagged content failed (${status}): ${String(error)}`,
      );
      return {
        ...base,
        status,
        decision: null,
        category: null,
        summary: null,
        items: [],
        dropped: 0,
      };
    }
  }
}
