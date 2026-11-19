import { FakeModel, providerError } from '@nestjs/ai/testing';
import { Test } from '@nestjs/testing';
import {
  ContentEvidenceService,
  MODERATION_EVIDENCE_MODEL,
} from '../../../src/moderation/content-evidence.service.js';
import type { EvidenceSources } from '../../../src/moderation/content-evidence.js';
import { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import type { ContentPolicySettings } from '../../../src/moderation/policies/content.js';

const policy: ContentPolicySettings = {
  instructions: 'Judge safety only.',
  allowDescription: 'Recipes and opinions.',
  choices: [
    {
      key: 'violence',
      label: 'Bạo lực',
      reasonText: 'bạo lực',
      description: 'Threats.',
    },
    { key: 'spam', label: 'Spam', reasonText: 'spam', description: 'Ads.' },
  ],
};

const sources: EvidenceSources = {
  texts: [
    {
      field: 'body',
      mediaId: null,
      text: 'Tao biết nhà mày ở đâu. Coi chừng.',
    },
  ],
  images: [
    {
      field: 'frame',
      jpeg: Buffer.from([0xff, 0xd8, 0xff]),
      mediaId: 'm1',
      seconds: 12.5,
      url: 'https://cdn/frame.jpg',
    },
  ],
};

async function createService(
  model: FakeModel,
): Promise<ContentEvidenceService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ContentEvidenceService,
      {
        provide: MODERATION_EVIDENCE_MODEL,
        useValue: { id: 'test/explainer', model },
      },
      {
        provide: ModerationSettingsService,
        useValue: { get: () => Promise.resolve(policy) },
      },
    ],
  }).compile();
  return moduleRef.get(ContentEvidenceService);
}

describe('ContentEvidenceService', () => {
  it('comes back FAILED when the post cannot be read, without calling the model', async () => {
    const model = new FakeModel([]);
    const service = await createService(model);

    await expect(
      service.explain(() => Promise.reject(new Error('No frame at 2.5s'))),
    ).resolves.toMatchObject({ status: 'FAILED', items: [] });
    expect(model.calls).toHaveLength(0);
  });

  it('sends the labelled text and frames, and keeps only verified evidence', async () => {
    const model = new FakeModel([
      {
        object: {
          decision: 'reject',
          category: 'violence',
          summary: ' Có lời đe dọa và quảng cáo. ',
          evidence: [
            {
              category: 'violence',
              reason: 'Đe dọa',
              quote: 'Tao biết nhà mày ở đâu',
              imageIndex: null,
              box: null,
            },
            {
              category: 'violence',
              reason: 'Bịa',
              quote: 'không có câu này',
              imageIndex: null,
              box: null,
            },
            {
              category: 'spam',
              reason: 'Quảng cáo',
              quote: 'NHÀ CÁI',
              imageIndex: 0,
              box: [10, 700, 990, 900],
            },
          ],
        },
      },
    ]);
    const service = await createService(model);

    const evidence = await service.explain(() => Promise.resolve(sources));

    expect(evidence).toMatchObject({
      status: 'READY',
      decision: 'reject',
      category: 'violence',
      summary: 'Có lời đe dọa và quảng cáo.',
      dropped: 1,
      model: 'test/explainer',
    });
    expect(
      evidence.items.map((item) => [item.field, item.start, item.seconds]),
    ).toEqual([
      ['body', 0, null],
      ['frame', null, 12.5],
    ]);
    const call = model.lastCall;
    expect(call?.instructions).toContain('- violence: Threats.');
    const prompt = JSON.stringify(call?.options.prompt);
    expect(prompt).toContain('[POST TEXT]');
    expect(prompt).toContain('[IMAGE 0: video frame at 12.5s]');
    expect(prompt).toContain('image/jpeg');
  });

  it('comes back FAILED, not clean, when the model does not answer', async () => {
    const service = await createService(new FakeModel([providerError(500)]));

    await expect(
      service.explain(() => Promise.resolve(sources)),
    ).resolves.toMatchObject({
      status: 'FAILED',
      decision: null,
      items: [],
    });
  });

  it('comes back FAILED when the answer does not match the schema', async () => {
    const service = await createService(
      new FakeModel([{ object: { verdict: 'ok' } }]),
    );

    await expect(
      service.explain(() => Promise.resolve(sources)),
    ).resolves.toMatchObject({ status: 'FAILED' });
  });
});
