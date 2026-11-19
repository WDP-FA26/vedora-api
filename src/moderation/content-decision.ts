import { ALLOW_KEY, MANIPULATION_KEY } from './policies/content.js';

export type ContentDecision = 'publish' | 'review' | 'reject';

export interface ContentThresholds {
  rejectThreshold: number;
  reviewThreshold: number;
  /**
   * When set, a `manipulation` chance at or above it is rejected whatever
   * the overall score. Left out while the rule is only recorded (shadow).
   */
  manipulationThreshold?: number;
}

/**
 * Category of an assessment the model could not score because its provider
 * refused to read the content (Google blocks the worst hate speech and sexual
 * content before the model sees it). It is not a policy choice, so it never
 * appears among the scores a model returns.
 */
export const PROVIDER_BLOCKED_KEY = 'provider_blocked';

export interface ContentAssessment {
  decision: ContentDecision;
  category: string | null;
  violationScore: number;
  scores: Record<string, number>;
}

/** Content the provider refused: held for an admin instead of being scored. */
export function providerBlockedAssessment(): ContentAssessment {
  return {
    decision: 'review',
    category: PROVIDER_BLOCKED_KEY,
    violationScore: 1,
    scores: { [PROVIDER_BLOCKED_KEY]: 1 },
  };
}

export function isProviderBlocked(assessment: ContentAssessment): boolean {
  return assessment.category === PROVIDER_BLOCKED_KEY;
}

export function assessContent(
  choice: string,
  probabilities: Record<string, number> | undefined,
  {
    rejectThreshold,
    reviewThreshold,
    manipulationThreshold,
  }: ContentThresholds,
): ContentAssessment {
  const scores = probabilities ?? { [choice]: 1 };
  const violationScore = 1 - (scores[ALLOW_KEY] ?? 0);
  let category: string | null = null;
  let best = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (key !== ALLOW_KEY && score > best) {
      category = key;
      best = score;
    }
  }
  const manipulation = scores[MANIPULATION_KEY] ?? 0;
  if (
    manipulationThreshold !== undefined &&
    manipulation >= manipulationThreshold
  ) {
    return {
      decision: 'reject',
      category: MANIPULATION_KEY,
      violationScore,
      scores,
    };
  }
  let decision: ContentDecision = 'publish';
  if (violationScore >= rejectThreshold) decision = 'reject';
  else if (violationScore >= reviewThreshold) decision = 'review';
  return { decision, category, violationScore, scores };
}
