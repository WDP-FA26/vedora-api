import { assessContent } from '../../../src/moderation/content-decision.js';
import {
  DEFAULT_CONTENT_POLICY,
  MANIPULATION_KEY,
  withReservedChoices,
} from '../../../src/moderation/policies/content.js';

const thresholds = { rejectThreshold: 0.85, reviewThreshold: 0.3 };

describe('the manipulation rule', () => {
  const scores = { allow: 0.35, manipulation: 0.55, spam: 0.1 };

  it('rejects for manipulation at the threshold when the rule is enforced', () => {
    expect(
      assessContent('manipulation', scores, {
        ...thresholds,
        manipulationThreshold: 0.5,
      }),
    ).toMatchObject({ decision: 'reject', category: MANIPULATION_KEY });
  });

  it('only scores it when the rule is not enforced (shadow)', () => {
    expect(assessContent('manipulation', scores, thresholds)).toMatchObject({
      decision: 'review',
      category: MANIPULATION_KEY,
    });
  });

  it('leaves content under the threshold to the usual thresholds', () => {
    expect(
      assessContent(
        'spam',
        { allow: 0.95, manipulation: 0.03, spam: 0.02 },
        {
          ...thresholds,
          manipulationThreshold: 0.5,
        },
      ).decision,
    ).toBe('publish');
  });
});

describe('withReservedChoices', () => {
  it('ships manipulation in the default policy', () => {
    expect(DEFAULT_CONTENT_POLICY.choices.map(({ key }) => key)).toContain(
      MANIPULATION_KEY,
    );
  });

  it('adds manipulation back to a policy that dropped it, once', () => {
    const spam = {
      key: 'spam',
      label: 'Spam',
      reasonText: 'spam',
      description: 'Unrelated ads.',
    };
    const restored = withReservedChoices([spam]);
    expect(restored.map(({ key }) => key)).toEqual(['spam', MANIPULATION_KEY]);
    expect(withReservedChoices(restored)).toBe(restored);
  });
});
