import {
  assessContent,
  isProviderBlocked,
  providerBlockedAssessment,
} from '../../../src/moderation/content-decision.js';

const THRESHOLDS = { rejectThreshold: 0.85, reviewThreshold: 0.3 };

/**
 * Threshold boundaries documented in docs/docs-for-FE/content-moderation.md:
 * violation = 1 - P(allow); >= reject → REJECTED, >= review → PENDING_REVIEW.
 */
describe('assessContent thresholds', () => {
  it('publishes when the violation chance is just under the review threshold', () => {
    const result = assessContent(
      'allow',
      { allow: 0.71, spam: 0.29 },
      THRESHOLDS,
    );

    expect(result.decision).toBe('publish');
  });

  it('holds for review at exactly the review threshold', () => {
    const result = assessContent('spam', { allow: 0.7, spam: 0.3 }, THRESHOLDS);

    expect(result.decision).toBe('review');
    expect(result.category).toBe('spam');
  });

  it('holds for review just under the reject threshold', () => {
    const result = assessContent(
      'hate',
      { allow: 0.16, hate: 0.84 },
      THRESHOLDS,
    );

    expect(result.decision).toBe('review');
  });

  it('rejects at exactly the reject threshold', () => {
    const result = assessContent(
      'hate',
      { allow: 0.15, hate: 0.85 },
      THRESHOLDS,
    );

    expect(result.decision).toBe('reject');
  });

  it('names the most likely violating category, not the model choice', () => {
    const result = assessContent(
      'spam',
      { allow: 0.1, spam: 0.3, hate: 0.6 },
      THRESHOLDS,
    );

    expect(result.category).toBe('hate');
  });

  it('adds up spread-out violations instead of looking at the top one only', () => {
    const result = assessContent(
      'allow',
      { allow: 0.4, spam: 0.2, hate: 0.2, sexual: 0.2 },
      THRESHOLDS,
    );

    expect(result.violationScore).toBeCloseTo(0.6);
    expect(result.decision).toBe('review');
  });

  it('treats a bare choice without probabilities as certain', () => {
    expect(assessContent('allow', undefined, THRESHOLDS).decision).toBe(
      'publish',
    );
    expect(assessContent('spam', undefined, THRESHOLDS).decision).toBe(
      'reject',
    );
  });

  it('marks a provider refusal for review with full violation', () => {
    const blocked = providerBlockedAssessment();

    expect(blocked.decision).toBe('review');
    expect(blocked.violationScore).toBe(1);
    expect(isProviderBlocked(blocked)).toBe(true);
  });
});
