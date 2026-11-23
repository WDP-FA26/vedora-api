import { MockLanguageModelV4 } from 'ai/test';
import { CalorieEstimator } from '../../../src/meal-plan/meal-log/calorie-estimator.js';

type Content = ConstructorParameters<typeof MockLanguageModelV4>[0];

function modelReplying(
  text: string,
  sources: { url: string; title?: string }[] = [],
): MockLanguageModelV4 {
  const options: Content = {
    doGenerate: () =>
      Promise.resolve({
        content: [
          ...sources.map((source, index) => ({
            type: 'source' as const,
            sourceType: 'url' as const,
            id: `s${index}`,
            url: source.url,
            title: source.title,
          })),
          { type: 'text' as const, text },
        ],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 10,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  };
  return new MockLanguageModelV4(options);
}

describe('CalorieEstimator', () => {
  it('reads the fenced JSON and merges web citations with listed references', async () => {
    const model = modelReplying(
      'Đây là kết quả:\n```json\n{"caloriesPerServing": 452.6, "note": " Tô vừa ~500 g ", "references": [{"title": "Viện Dinh dưỡng", "url": "https://viendinhduong.vn/a"}, {"title": "trùng", "url": "https://fdc.nal.usda.gov/x"}]}\n```',
      [{ url: 'https://fdc.nal.usda.gov/x', title: 'USDA' }],
    );
    const estimate = await new CalorieEstimator(model).estimate({
      name: 'Bún riêu chay',
      details: 'tô vừa',
    });
    expect(estimate).toEqual({
      caloriesPerServing: 453,
      note: 'Tô vừa ~500 g',
      references: [
        { title: 'USDA', url: 'https://fdc.nal.usda.gov/x' },
        { title: 'Viện Dinh dưỡng', url: 'https://viendinhduong.vn/a' },
      ],
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain('Bún riêu chay');
    expect(prompt).toContain('tô vừa');
  });

  it.each([0, -5, 5001, Number.NaN])(
    'drops an unusable calorie value %s',
    async (value) => {
      const estimate = await new CalorieEstimator(
        modelReplying(`{"caloriesPerServing": ${String(value)}, "note": "x"}`),
      ).estimate({ name: 'Món' });
      expect(estimate.caloriesPerServing).toBeNull();
    },
  );

  it('returns no estimate but keeps citations when the reply is not JSON', async () => {
    const estimate = await new CalorieEstimator(
      modelReplying('Không tìm thấy.', [{ url: 'https://example.com/a' }]),
    ).estimate({ name: 'Món lạ' });
    expect(estimate).toEqual({
      caloriesPerServing: null,
      note: null,
      references: [{ title: 'example.com', url: 'https://example.com/a' }],
    });
  });

  it('keeps as many references as a log entry accepts', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      url: `https://example.com/${index}`,
    }));
    const estimate = await new CalorieEstimator(
      modelReplying('{"caloriesPerServing": 300}', sources),
    ).estimate({ name: 'Món' });
    expect(estimate.references).toHaveLength(5);
  });

  it('drops non-http references', async () => {
    const estimate = await new CalorieEstimator(
      modelReplying(
        '{"caloriesPerServing": 300, "references": [{"title": "x", "url": "javascript:alert(1)"}]}',
      ),
    ).estimate({ name: 'Món' });
    expect(estimate.references).toEqual([]);
  });
});
