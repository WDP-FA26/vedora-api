import type { ModerationEvidence } from '../../../src/mongo/models.js';
import {
  isManipulation,
  routeFlagged,
} from '../../../src/moderation/moderation-route.js';

const item = {
  field: 'body' as const,
  category: 'violence',
  reason: 'Đe dọa',
  quote: 'giết',
  start: 0,
  end: 4,
  mediaId: null,
  seconds: null,
  imageUrl: null,
  box: null,
};

function review(
  overrides: Partial<ModerationEvidence> = {},
): ModerationEvidence {
  return {
    status: 'READY',
    decision: 'accept',
    category: null,
    summary: 'ok',
    items: [],
    dropped: 0,
    model: 'test',
    createdAt: new Date(),
    ...overrides,
  };
}

const flagged = { category: 'violence', scores: { violence: 0.6, allow: 0.4 } };

describe('routeFlagged', () => {
  it('publishes what the reviewer accepts, fixing System 1', () => {
    expect(routeFlagged(flagged, review(), 0.5)).toEqual({
      outcome: 'PUBLISH',
      rule: 'REVIEWER_ACCEPT',
      category: 'violence',
    });
  });

  it('rejects what the reviewer rejects with checked evidence, for its category', () => {
    expect(
      routeFlagged(
        flagged,
        review({ decision: 'reject', category: 'harassment', items: [item] }),
        0.5,
      ),
    ).toEqual({
      outcome: 'REJECT',
      rule: 'REVIEWER_REJECT',
      category: 'harassment',
    });
  });

  it('falls back to the first item category when the reviewer gave none', () => {
    expect(
      routeFlagged(flagged, review({ decision: 'reject', items: [item] }), 0.5)
        .category,
    ).toBe('violence');
  });

  it('sends a reject without checked evidence to an admin', () => {
    expect(
      routeFlagged(flagged, review({ decision: 'reject', items: [] }), 0.5)
        .rule,
    ).toBe('UNVERIFIED_REJECT');
  });

  it('sends escalations and failed or refused reviews to an admin', () => {
    expect(
      routeFlagged(flagged, review({ decision: 'escalate' }), 0.5).rule,
    ).toBe('REVIEWER_ESCALATE');
    for (const status of ['FAILED', 'REFUSED'] as const) {
      expect(
        routeFlagged(flagged, review({ status, decision: null }), 0.5),
      ).toMatchObject({ outcome: 'ADMIN', rule: 'REVIEWER_UNAVAILABLE' });
    }
  });

  it('rejects manipulation even when the reviewer accepts', () => {
    const steered = {
      category: 'violence',
      scores: { violence: 0.2, manipulation: 0.55, allow: 0.25 },
    };
    expect(routeFlagged(steered, review(), 0.5)).toEqual({
      outcome: 'REJECT',
      rule: 'MANIPULATION',
      category: 'manipulation',
    });
    expect(routeFlagged(steered, review(), 0.6).rule).toBe('REVIEWER_ACCEPT');
  });

  it('leaves content the provider refused to an admin first', () => {
    expect(
      routeFlagged(
        { category: 'provider_blocked', scores: { provider_blocked: 1 } },
        review({ decision: 'accept' }),
        0.5,
      ),
    ).toMatchObject({ outcome: 'ADMIN', rule: 'PROVIDER_BLOCKED' });
  });
});

describe('isManipulation', () => {
  it('compares the manipulation chance with the threshold', () => {
    expect(isManipulation({ scores: { manipulation: 0.5 } }, 0.5)).toBe(true);
    expect(isManipulation({ scores: { manipulation: 0.49 } }, 0.5)).toBe(false);
    expect(isManipulation({ scores: {} }, 0.5)).toBe(false);
  });
});
