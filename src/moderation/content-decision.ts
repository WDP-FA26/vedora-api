import { ALLOW_KEY } from './policies/content.js';

export type ContentDecision = 'publish' | 'review' | 'reject';

export interface ContentThresholds {
  rejectThreshold: number;
  reviewThreshold: number;
}

export interface ContentAssessment {
  decision: ContentDecision;
  category: string | null;
  violationScore: number;
  scores: Record<string, number>;
}

export function assessContent(
  choice: string,
  probabilities: Record<string, number> | undefined,
  { rejectThreshold, reviewThreshold }: ContentThresholds,
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
  let decision: ContentDecision = 'publish';
  if (violationScore >= rejectThreshold) decision = 'reject';
  else if (violationScore >= reviewThreshold) decision = 'review';
  return { decision, category, violationScore, scores };
}
