import { MockLanguageModelV4 } from 'ai/test';
import { CalorieEstimator } from '@src/meal-plan/meal-log/calorie-estimator.js';

type Content = ConstructorParameters<typeof MockLanguageModelV4>[0];

/** A model that searched (the sources) and then submitted `input`, the submitEstimate arguments as JSON text; null replies with text instead. */
function modelReplying(
  input: string | null,
  sources: { url: string; title?: string }[] = [],
): MockLanguageModelV4 {
  const answer =
    input === null
      ? { type: 'text' as const, text: 'Không tìm thấy.' }
      : {
          type: 'tool-call' as const,
          toolCallId: 'call-1',
          toolName: 'submitEstimate',
          input,
        };
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
          answer,
        ],
        finishReason: {
          unified: input === null ? ('stop' as const) : ('tool-calls' as const),
          raw: undefined,
        },
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
  it('reads the submitted estimate and merges web citations with listed references', async () => {
    const model = modelReplying(
      '{"caloriesPerServing": 452.6, "note": " Tô vừa ~500 g ", "references": [{"title": "Viện Dinh dưỡng", "url": "https://viendinhduong.vn/a"}, {"title": "trùng", "url": "https://fdc.nal.usda.gov/x"}]}',
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
    const toolNames = model.doGenerateCalls[0].tools?.map((item) => item.name);
    expect(toolNames).toContain('submitEstimate');
  });

  it.each([0, -5, 5001, Number.NaN])(
    'drops an unusable calorie value %s',
    async (value) => {
      const estimate = await new CalorieEstimator(
        modelReplying(
          `{"caloriesPerServing": ${String(value)}, "note": "x", "references": []}`,
        ),
      ).estimate({ name: 'Món' });
      expect(estimate.caloriesPerServing).toBeNull();
    },
  );

  it.each([
    ['replies with text', null],
    ['submits arguments outside the schema', '{"caloriesPerServing": "nhiều"}'],
  ])(
    'returns no estimate but keeps citations when the model %s',
    async (_case, input) => {
      const estimate = await new CalorieEstimator(
        modelReplying(input, [{ url: 'https://example.com/a' }]),
      ).estimate({ name: 'Món lạ' });
      expect(estimate).toEqual({
        caloriesPerServing: null,
        note: null,
        references: [{ title: 'example.com', url: 'https://example.com/a' }],
      });
    },
  );

  it('keeps as many references as a log entry accepts', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      url: `https://example.com/${index}`,
    }));
    const estimate = await new CalorieEstimator(
      modelReplying(
        '{"caloriesPerServing": 300, "note": null, "references": []}',
        sources,
      ),
    ).estimate({ name: 'Món' });
    expect(estimate.references).toHaveLength(5);
  });

  it('drops non-http references', async () => {
    const estimate = await new CalorieEstimator(
      modelReplying(
        '{"caloriesPerServing": 300, "note": null, "references": [{"title": "x", "url": "javascript:alert(1)"}]}',
      ),
    ).estimate({ name: 'Món' });
    expect(estimate.references).toEqual([]);
  });
});
