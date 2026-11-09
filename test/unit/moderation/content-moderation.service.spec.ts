import type { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import type { Experimental_EvaluationModel } from 'ai';
import { vi } from 'vitest';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { UnprocessableContentException } from '../../../src/common/exceptions/unprocessable-content.exception.js';
import { ContentModerationService } from '../../../src/moderation/content-moderation.service.js';
import { DEFAULT_CONTENT_POLICY } from '../../../src/moderation/policies/content.js';

const VERDICTS = [
  'allow',
  ...DEFAULT_CONTENT_POLICY.choices.map(({ key }) => key),
];

const settings = {
  get: () =>
    Promise.resolve({
      ...DEFAULT_CONTENT_POLICY,
      rejectThreshold: 0.85,
      reviewThreshold: 0.3,
    }),
} as unknown as ModerationSettingsService;

function complete(chances: Record<string, number>): Record<string, number> {
  const all: Record<string, number> = {};
  for (const verdict of VERDICTS) all[verdict] = chances[verdict] ?? 0;
  return all;
}

function modelAnswering(
  choice: string,
  probabilities?: Record<string, number>,
) {
  const doEvaluate = vi.fn((_options: { state: unknown }) =>
    Promise.resolve({
      answers: {
        verdict: {
          type: 'choice' as const,
          choice,
          probabilities: probabilities && complete(probabilities),
        },
      },
      warnings: [],
    }),
  );
  const model = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'jev',
    supportedQuestionTypes: ['choice'],
    doEvaluate,
  } as unknown as Experimental_EvaluationModel;
  const service = new ContentModerationService(model, settings);
  return { service, doEvaluate };
}

const text = (value: string) => [{ kind: 'text' as const, text: value }];

describe('ContentModerationService', () => {
  it('publishes empty content without calling the model', async () => {
    const { service, doEvaluate } = modelAnswering('sexual');
    expect((await service.review(text('   '))).decision).toBe('publish');
    expect(doEvaluate).not.toHaveBeenCalled();
  });

  it('sends text parts to the model', async () => {
    const { service, doEvaluate } = modelAnswering('allow');
    await service.review(text('hello'));
    expect(doEvaluate.mock.calls[0]?.[0].state).toEqual(['hello']);
  });

  it.each([
    ['clear', { allow: 0.99, hate: 0.01 }, 'allow', 'publish'],
    ['a likely violation', { allow: 0.05, hate: 0.95 }, 'hate', 'reject'],
    ['an unsure violation', { allow: 0.4, hate: 0.6 }, 'hate', 'review'],
    ['an allow with doubt', { allow: 0.6, spam: 0.4 }, 'allow', 'review'],
  ])('decides %s', async (_name, probabilities, choice, decision) => {
    const { service } = modelAnswering(choice, probabilities);
    const assessment = await service.review(text('x'));
    expect(assessment.decision).toBe(decision);
    expect(assessment.scores).toEqual(complete(probabilities));
  });

  it('treats a verdict without probabilities as certain', async () => {
    const { service } = modelAnswering('hate');
    expect(await service.review(text('x'))).toMatchObject({
      decision: 'reject',
      category: 'hate',
      violationScore: 1,
    });
  });

  it('rejects a comment only when the model is confident', async () => {
    const confident = modelAnswering('spam', { allow: 0.02, spam: 0.98 });
    await expect(
      confident.service.requireAllowed(text('buy now')),
    ).rejects.toMatchObject({
      constructor: UnprocessableContentException,
      code: 'CONTENT_REJECTED',
      details: { category: 'spam' },
    });
    const unsure = modelAnswering('spam', { allow: 0.45, spam: 0.55 });
    await expect(
      unsure.service.requireAllowed(text('hm')),
    ).resolves.toBeUndefined();
  });

  it('reports 503 instead of accepting content when the model fails', async () => {
    const { service, doEvaluate } = modelAnswering('allow');
    doEvaluate.mockRejectedValue(new Error('boom'));
    await expect(service.requireAllowed(text('hi'))).rejects.toBeInstanceOf(
      FeatureUnavailableException,
    );
  });
});

describe('ContentModerationService with an edited policy', () => {
  it('asks the model about the saved categories and thresholds', async () => {
    const doEvaluate = vi.fn(
      (_options: { questions: { verdict: { criteria: object } } }) =>
        Promise.resolve({
          answers: {
            verdict: {
              type: 'choice' as const,
              choice: 'politics',
              probabilities: { politics: 0.6, allow: 0.4 },
            },
          },
          warnings: [],
        }),
    );
    const model = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'jev',
      supportedQuestionTypes: ['choice'],
      doEvaluate,
    } as unknown as Experimental_EvaluationModel;
    const custom = {
      get: () =>
        Promise.resolve({
          instructions: 'Judge posts on a cooking network, safety only.',
          allowDescription: 'Cooking and everyday talk.',
          choices: [
            {
              key: 'politics',
              label: 'Chính trị',
              reasonText: 'nội dung chính trị',
              description: 'Campaigning or partisan political messaging.',
            },
          ],
          rejectThreshold: 0.7,
          reviewThreshold: 0.2,
        }),
    } as unknown as ModerationSettingsService;

    const assessment = await new ContentModerationService(model, custom).review(
      text('Bầu cho ông A'),
    );

    const question = doEvaluate.mock.calls[0]?.[0].questions.verdict;
    expect(Object.keys(question?.criteria ?? {})).toEqual([
      'politics',
      'allow',
    ]);
    expect(assessment).toMatchObject({
      category: 'politics',
      decision: 'review',
    });
  });
});
