import { FakeModel, providerError } from '@nestjs/ai/testing';
import { APICallError } from 'ai';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { UnprocessableContentException } from '../../../src/common/exceptions/unprocessable-content.exception.js';
import type { EvidenceSources } from '../../../src/moderation/content-evidence.js';
import { ContentModerationService } from '../../../src/moderation/content-moderation.service.js';
import type { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import {
  DEFAULT_CONTENT_POLICY,
  withReservedChoices,
} from '../../../src/moderation/policies/content.js';

const POLICY = {
  ...DEFAULT_CONTENT_POLICY,
  choices: withReservedChoices(DEFAULT_CONTENT_POLICY.choices),
};

class FakeSettings implements Pick<
  ModerationSettingsService,
  'get' | 'reasonTexts'
> {
  get() {
    return Promise.resolve({
      ...POLICY,
      version: 0,
      updatedById: null,
      updatedAt: null,
    });
  }

  reasonTexts() {
    return Promise.resolve(
      new Map(POLICY.choices.map((choice) => [choice.key, choice.reasonText])),
    );
  }
}

interface Answer {
  riskLevel: number;
  category: string | null;
  summary?: string;
  evidence?: {
    category: string;
    reason: string;
    quote: string | null;
    imageIndex: number | null;
  }[];
}

function serviceAnswering(answer: Answer | Error | (() => Error)) {
  const model = new FakeModel(() => {
    if (answer instanceof Error) return answer;
    if (typeof answer === 'function') return answer();
    return {
      object: { summary: 'Tóm tắt.', evidence: [], ...answer },
    };
  });
  const settings = new FakeSettings();
  const service = new ContentModerationService(
    { id: 'anthropic/claude-haiku-5.5', model },
    // The service only reads settings.get() and settings.reasonTexts().
    settings as ModerationSettingsService,
  );
  return { service, model };
}

const text = (value: string): EvidenceSources => ({
  texts: [{ field: 'body', mediaId: null, text: value }],
  images: [],
});

const threat = {
  category: 'violence',
  reason: 'Lời đe dọa.',
  quote: 'tao sẽ đánh mày',
  imageIndex: null,
};

describe('ContentModerationService', () => {
  it('publishes empty content without calling the model', async () => {
    const { service, model } = serviceAnswering({
      riskLevel: 3,
      category: 'violence',
    });
    expect(await service.review(text('   '))).toEqual({
      decision: 'publish',
      category: null,
      riskLevel: 0,
      evidence: null,
    });
    expect(model.calls).toHaveLength(0);
  });

  it('sends the policy as instructions and the content inside <content>', async () => {
    const { service, model } = serviceAnswering({
      riskLevel: 0,
      category: null,
    });
    await service.review(text('cơm chay ngon'));
    const call = model.lastCall;
    expect(call?.instructions).toContain(POLICY.instructions);
    expect(call?.instructions).toContain('3 - High risk');
    expect(JSON.stringify(call?.options.prompt)).toContain('<content>');
    expect(JSON.stringify(call?.options.prompt)).toContain('</content>');
    expect(JSON.stringify(call?.options.prompt)).toContain('cơm chay ngon');
  });

  it.each([
    [0, 'publish'],
    [1, 'publish'],
    [2, 'review'],
  ] as const)('maps risk level %i to %s', async (riskLevel, decision) => {
    const { service } = serviceAnswering({ riskLevel, category: 'violence' });
    const assessment = await service.review(text('tao sẽ đánh mày'));
    expect(assessment.decision).toBe(decision);
    expect(assessment.riskLevel).toBe(riskLevel);
    expect(assessment.evidence?.status).toBe('READY');
  });

  it('rejects a high risk backed by a quote found in the content', async () => {
    const { service } = serviceAnswering({
      riskLevel: 3,
      category: 'violence',
      evidence: [threat],
    });
    const assessment = await service.review(text('Ê, tao sẽ đánh mày'));
    expect(assessment).toMatchObject({
      decision: 'reject',
      category: 'violence',
      riskLevel: 3,
    });
    expect(assessment.evidence?.items).toEqual([
      expect.objectContaining({ field: 'body', start: 3, end: 18 }),
    ]);
  });

  it('holds a high risk for an admin when no evidence matches the content', async () => {
    const { service } = serviceAnswering({
      riskLevel: 3,
      category: 'violence',
      evidence: [{ ...threat, quote: 'not in the post' }],
    });
    const assessment = await service.review(text('một bài bình thường'));
    expect(assessment.decision).toBe('review');
    expect(assessment.evidence?.dropped).toBe(1);
  });

  it('records no category at risk level 0', async () => {
    const { service } = serviceAnswering({ riskLevel: 0, category: 'spam' });
    expect((await service.review(text('hi'))).category).toBeNull();
  });

  it('throws on a risk level out of range', async () => {
    const { service } = serviceAnswering({ riskLevel: 7, category: null });
    await expect(service.review(text('hi'))).rejects.toThrow('risk level 7');
  });

  it('throws on a category outside the policy', async () => {
    const { service } = serviceAnswering({
      riskLevel: 3,
      category: 'made_up',
    });
    await expect(service.review(text('hi'))).rejects.toThrow();
  });

  it('holds content the model refuses to rate for an admin', async () => {
    const model = new FakeModel(() => ({
      text: '',
      finishReason: 'content-filter',
    }));
    const service = new ContentModerationService(
      { id: 'anthropic/claude-haiku-5.5', model },
      new FakeSettings() as ModerationSettingsService,
    );
    expect(await service.review(text('x'))).toMatchObject({
      decision: 'review',
      category: 'provider_blocked',
      riskLevel: null,
      evidence: { status: 'REFUSED', items: [] },
    });
  });

  it('holds content the provider refuses to read for an admin', async () => {
    const { service } = serviceAnswering(
      new APICallError({
        message: 'Input blocked',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 400,
        responseBody: '{"error":{"code":"prohibited_content"}}',
      }),
    );
    expect(await service.review(text('x'))).toMatchObject({
      decision: 'review',
      category: 'provider_blocked',
    });
  });

  it('rejects other provider errors', async () => {
    const { service } = serviceAnswering(providerError(400));
    await expect(service.review(text('x'))).rejects.toBeInstanceOf(
      APICallError,
    );
  });

  it('tries a draft policy, adding the built-in categories', async () => {
    const { service, model } = serviceAnswering({
      riskLevel: 2,
      category: 'manipulation',
    });
    const draft = {
      instructions: 'Only spam matters here.',
      allowDescription: 'Everything else.',
      choices: [
        {
          key: 'spam',
          label: 'Spam',
          reasonText: 'spam',
          description: 'Unrelated ads.',
        },
      ],
    };
    const assessment = await service.review(text('x'), draft);
    expect(assessment.category).toBe('manipulation');
    expect(model.lastCall?.instructions).toContain('\nspam: Unrelated ads.');
    expect(model.lastCall?.options.prompt[0]).not.toHaveProperty(
      'providerOptions.openrouter.cacheControl',
    );
  });

  it('caches live policy instructions with 1h TTL and sticky session_id', async () => {
    const { service, model } = serviceAnswering({
      riskLevel: 0,
      category: null,
    });
    await service.review(text('cơm chay thanh đạm'));
    expect(model.lastCall?.options.prompt[0]).toMatchObject({
      role: 'system',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(model.lastCall?.options.providerOptions?.openrouter).toEqual({
      session_id: 'vedora-content-moderation',
    });
  });
});

describe('ContentModerationService.requireAllowed', () => {
  it('turns away a high-risk comment and tells the author which words and why', async () => {
    const { service } = serviceAnswering({
      riskLevel: 3,
      category: 'violence',
      evidence: [threat],
    });
    const reasonText = POLICY.choices.find(
      (choice) => choice.key === 'violence',
    )?.reasonText;
    await expect(
      service.requireAllowed('Nói nữa tao sẽ đánh mày'),
    ).rejects.toMatchObject({
      constructor: UnprocessableContentException,
      code: 'CONTENT_REJECTED',
      details: {
        category: 'violence',
        reasonText,
        findings: [
          { quote: 'tao sẽ đánh mày', reason: 'Lời đe dọa.', reasonText },
        ],
      },
    });
  });

  it('lets a medium-risk comment through, since comments have no queue', async () => {
    const { service } = serviceAnswering({ riskLevel: 2, category: 'spam' });
    await expect(service.requireAllowed('hm')).resolves.toBeUndefined();
  });

  it('turns away a comment the model refuses to read', async () => {
    const { service } = serviceAnswering(
      new APICallError({
        message: 'Input blocked',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 400,
        responseBody: '{"error":{"code":"prohibited_content"}}',
      }),
    );
    await expect(service.requireAllowed('x')).rejects.toMatchObject({
      details: { category: 'provider_blocked' },
    });
  });

  it('reports 503 instead of accepting a comment when the model fails', async () => {
    const { service } = serviceAnswering(new Error('boom'));
    await expect(service.requireAllowed('hi')).rejects.toBeInstanceOf(
      FeatureUnavailableException,
    );
  });
});
