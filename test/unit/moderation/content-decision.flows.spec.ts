import {
  decisionFor,
  failedAssessment,
  isProviderBlocked,
  providerBlockedAssessment,
} from '../../../src/moderation/content-decision.js';

describe('decisionFor', () => {
  it.each([
    [0, 0, 'publish'],
    [1, 2, 'publish'],
    [2, 0, 'review'],
    [2, 3, 'review'],
    [3, 1, 'reject'],
    [3, 0, 'review'],
  ] as const)(
    'risk %i with %i checked evidence: %s',
    (riskLevel, evidence, decision) => {
      expect(decisionFor(riskLevel, evidence)).toBe(decision);
    },
  );
});

describe('unrated assessments', () => {
  it('holds content the model refused to read for an admin', () => {
    const blocked = providerBlockedAssessment('model-x');
    expect(blocked).toMatchObject({
      decision: 'review',
      category: 'provider_blocked',
      riskLevel: null,
      evidence: { status: 'REFUSED', model: 'model-x', items: [] },
    });
    expect(isProviderBlocked(blocked)).toBe(true);
  });

  it('holds content the model failed to rate for an admin', () => {
    const failed = failedAssessment('model-x');
    expect(failed).toMatchObject({
      decision: 'review',
      category: 'moderation_failed',
      riskLevel: null,
      evidence: { status: 'FAILED' },
    });
    expect(isProviderBlocked(failed)).toBe(false);
  });
});
