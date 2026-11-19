import type {
  ModerationEvidence,
  RouteOutcome,
  RouteRule,
} from '../mongo/models.js';
import {
  type ContentAssessment,
  PROVIDER_BLOCKED_KEY,
} from './content-decision.js';
import { MANIPULATION_KEY } from './policies/content.js';

export interface RoutedVerdict {
  outcome: RouteOutcome;
  rule: RouteRule;
  /** The category the outcome stands for; System 1's for PUBLISH and ADMIN. */
  category: string | null;
}

type Classified = Pick<ContentAssessment, 'category' | 'scores'>;

/** True when System 1's `manipulation` chance reaches the threshold. */
export function isManipulation(
  assessment: Pick<ContentAssessment, 'scores'>,
  threshold: number,
): boolean {
  return (assessment.scores[MANIPULATION_KEY] ?? 0) >= threshold;
}

/**
 * Where a post System 1 flagged goes, from System 1's scores and the reviewer
 * model's answer. The first rule that matches wins; every outcome the
 * reviewer cannot back with checked evidence ends with an admin.
 */
export function routeFlagged(
  assessment: Classified,
  review: ModerationEvidence,
  manipulationThreshold: number,
): RoutedVerdict {
  if (assessment.category === PROVIDER_BLOCKED_KEY) {
    return {
      outcome: 'ADMIN',
      rule: 'PROVIDER_BLOCKED',
      category: assessment.category,
    };
  }
  if (isManipulation(assessment, manipulationThreshold)) {
    return {
      outcome: 'REJECT',
      rule: 'MANIPULATION',
      category: MANIPULATION_KEY,
    };
  }
  if (review.status !== 'READY' || review.decision === null) {
    return {
      outcome: 'ADMIN',
      rule: 'REVIEWER_UNAVAILABLE',
      category: assessment.category,
    };
  }
  if (review.decision === 'reject') {
    if (review.items.length === 0) {
      return {
        outcome: 'ADMIN',
        rule: 'UNVERIFIED_REJECT',
        category: assessment.category,
      };
    }
    const category = review.category ?? review.items[0].category;
    return { outcome: 'REJECT', rule: 'REVIEWER_REJECT', category };
  }
  if (review.decision === 'escalate') {
    return {
      outcome: 'ADMIN',
      rule: 'REVIEWER_ESCALATE',
      category: assessment.category,
    };
  }
  return {
    outcome: 'PUBLISH',
    rule: 'REVIEWER_ACCEPT',
    category: assessment.category,
  };
}
