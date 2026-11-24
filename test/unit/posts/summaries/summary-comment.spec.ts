import {
  formatIngredient,
  formatSummaryComment,
} from '@src/posts/summaries/summary-comment.js';
import type { SummaryRecipe } from '@src/mongo/models.js';

const recipe: SummaryRecipe = {
  title: 'Canh nấm',
  description: null,
  tag: null,
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 20,
  ingredients: [
    { name: 'nấm rơm', quantity: 200, unit: 'g', note: null },
    { name: 'muối', quantity: null, unit: null, note: 'vừa đủ' },
  ],
  steps: ['Rửa nấm.', 'Nấu nước sôi rồi cho nấm vào.'],
};

describe('formatSummaryComment', () => {
  it('writes the summary, the recipe and the disclaimer in Vietnamese', () => {
    const text = formatSummaryComment(
      { language: 'vi', summary: 'Canh nấm thanh mát.', recipe },
      1000,
    );
    expect(text).toBe(
      [
        'Canh nấm thanh mát.',
        '',
        'Canh nấm',
        'Khẩu phần: 4 · 30 phút',
        '',
        'Nguyên liệu:',
        '• 200 g nấm rơm',
        '• muối (vừa đủ)',
        '',
        'Cách làm:',
        '1. Rửa nấm.',
        '2. Nấu nước sôi rồi cho nấm vào.',
        '',
        'Tóm tắt tự động bởi Vedora AI từ nội dung bài đăng, có thể chưa chính xác.',
      ].join('\n'),
    );
  });

  it('uses English labels for other languages and works without a recipe', () => {
    const text = formatSummaryComment(
      { language: 'en', summary: 'A quick tofu tip.', recipe: null },
      1000,
    );
    expect(text).toBe(
      'A quick tofu tip.\n\nSummarized automatically by Vedora AI from this post; it may contain mistakes.',
    );
  });

  it('drops recipe lines from the end to fit, keeping the disclaimer', () => {
    const long: SummaryRecipe = {
      ...recipe,
      steps: Array.from({ length: 40 }, (_, i) => `Bước số ${i + 1} khá dài.`),
    };
    const text = formatSummaryComment(
      { language: 'vi', summary: 'Tóm tắt.', recipe: long },
      400,
    );
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain('… xem đầy đủ trong bài đăng.');
    expect(text.endsWith('có thể chưa chính xác.')).toBe(true);
  });

  it('cuts an overly long summary', () => {
    const text = formatSummaryComment(
      { language: 'vi', summary: 'a'.repeat(2000), recipe: null },
      300,
    );
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith('có thể chưa chính xác.')).toBe(true);
  });
});

describe('formatIngredient', () => {
  it('rounds fractional quantities', () => {
    expect(
      formatIngredient({
        name: 'dầu ăn',
        quantity: 0.3333,
        unit: 'muỗng',
        note: null,
      }),
    ).toBe('• 0.33 muỗng dầu ăn');
  });
});
