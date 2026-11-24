import {
  reviewInstructions,
  type ReviewEvidence,
  type EvidenceSources,
  validBox,
  verifyEvidence,
} from '../../../src/moderation/content-evidence.js';

function sources(): EvidenceSources {
  return {
    texts: [
      { field: 'body', mediaId: null, text: 'Video nấu đậu hũ sốt cà chua.' },
      {
        field: 'transcript',
        mediaId: 'm1',
        text: 'Cho đậu hũ vào chiên vàng. Sau đó tao sẽ giết cả nhà mày',
      },
    ],
    images: [
      {
        field: 'frame',
        jpeg: Buffer.from('a'),
        mediaId: 'm1',
        seconds: 2.5,
        url: 'https://cdn/f0.jpg',
      },
      {
        field: 'frame',
        jpeg: Buffer.from('b'),
        mediaId: 'm1',
        seconds: 7.5,
        url: 'https://cdn/f1.jpg',
      },
    ],
  };
}

function evidence(item: Partial<ReviewEvidence>): ReviewEvidence {
  return {
    category: 'violence',
    reason: 'Đe dọa',
    quote: null,
    imageIndex: null,
    box: null,
    ...item,
  };
}

describe('verifyEvidence', () => {
  it('finds a quote in whichever text holds it, whatever the model said', () => {
    const { items, dropped } = verifyEvidence(
      [evidence({ quote: 'tao sẽ giết cả nhà mày' })],
      sources(),
    );
    const transcript = sources().texts[1].text;
    expect(dropped).toBe(0);
    expect(items).toEqual([
      expect.objectContaining({
        field: 'transcript',
        mediaId: 'm1',
        quote: 'tao sẽ giết cả nhà mày',
        start: transcript.indexOf('tao'),
        end: transcript.indexOf('tao') + 'tao sẽ giết cả nhà mày'.length,
        imageUrl: null,
      }),
    ]);
  });

  it('matches a quote written with decomposed diacritics', () => {
    const { items } = verifyEvidence(
      [evidence({ quote: 'tao sẽ giết'.normalize('NFD') })],
      sources(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].quote).toBe('tao sẽ giết');
  });

  it('drops quotes that are not in the post and missing images', () => {
    const { items, dropped } = verifyEvidence(
      [
        evidence({ quote: 'tạo sẽ giết' }),
        evidence({ quote: '   ' }),
        evidence({ imageIndex: 5 }),
        evidence({ imageIndex: -1 }),
      ],
      sources(),
    );
    expect(items).toEqual([]);
    expect(dropped).toBe(4);
  });

  it('points a frame at its video, second and picture, keeping OCR text as is', () => {
    const { items } = verifyEvidence(
      [
        evidence({
          category: 'spam',
          imageIndex: 1,
          quote: 'NẠP 100K TĂNG 200K',
          box: [40, 800.4, 940, 960],
        }),
      ],
      sources(),
    );
    expect(items).toEqual([
      {
        field: 'frame',
        category: 'spam',
        reason: 'Đe dọa',
        quote: 'NẠP 100K TĂNG 200K',
        start: null,
        end: null,
        mediaId: 'm1',
        seconds: 7.5,
        imageUrl: 'https://cdn/f1.jpg',
        box: [40, 800, 940, 960],
      },
    ]);
  });

  it('keeps one item per place', () => {
    const { items } = verifyEvidence(
      [
        evidence({ quote: 'tao sẽ giết' }),
        evidence({ quote: 'tao sẽ giết', category: 'harassment' }),
        evidence({ imageIndex: 0 }),
        evidence({ imageIndex: 0 }),
      ],
      sources(),
    );
    expect(items.map((item) => item.field)).toEqual(['transcript', 'frame']);
  });
});

describe('validBox', () => {
  it('clamps to 0-1000 and rejects boxes that are not regions', () => {
    expect(validBox([-20, 10, 1200, 990])).toEqual([0, 10, 1000, 990]);
    expect(validBox(null)).toBeNull();
    expect(validBox([1, 2, 3])).toBeNull();
    expect(validBox([500, 10, 400, 20])).toBeNull();
    expect(validBox([10, 10, 10, 20])).toBeNull();
    expect(validBox([0, Number.NaN, 10, 20])).toBeNull();
  });
});

describe('reviewInstructions', () => {
  it('lists the policy categories, the risk levels, and asks for Vietnamese', () => {
    const text = reviewInstructions({
      instructions: 'Judge safety.',
      allowDescription: 'Recipes.',
      choices: [
        { key: 'spam', label: 'Spam', reasonText: 'spam', description: 'Ads.' },
      ],
    });
    expect(text).toContain('- spam: Ads.');
    expect(text).toContain('<allowed>Recipes.</allowed>');
    expect(text).toContain('2 - Medium risk');
    expect(text).toContain('Vietnamese');
  });
});
