import type { ModerationEvidence } from '../mongo/models.js';
import { HIGH_RISK, MEDIUM_RISK } from './content-evidence.js';

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
