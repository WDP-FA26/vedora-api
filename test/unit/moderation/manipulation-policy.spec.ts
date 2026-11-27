import { buildReviewInstructions } from '@src/moderation/content-evidence.js';
import {
  DEFAULT_CONTENT_POLICY,
  MANIPULATION_KEY,
  withReservedChoices,
} from '@src/moderation/policies/content.js';

describe('the manipulation rule', () => {
  it('tells the model to rate manipulation as a high risk', () => {
    const instructions = buildReviewInstructions(DEFAULT_CONTENT_POLICY);
    expect(instructions).toContain(
      `rate it 3 with category "${MANIPULATION_KEY}"`,
    );
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
