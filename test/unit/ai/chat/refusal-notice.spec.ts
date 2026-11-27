import { simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { refusalNotice } from '@src/ai/chat/refusal-notice.js';

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

const NOTICE = 'Mình không thể giúp yêu cầu này.';

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

async function reply(chunks: StreamPart[]): Promise<string> {
  const model = new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks,
        }),
      }),
  });
  const result = streamText({
    model,
    prompt: 'Câu hỏi',
    experimental_transform: refusalNotice(NOTICE),
  });
  let text = '';
  for await (const delta of result.textStream) text += delta;
  return text;
}

describe('refusalNotice', () => {
  it('answers with the notice when the model declines before writing', async () => {
    expect(
      await reply([
        {
          type: 'finish',
          finishReason: { unified: 'content-filter', raw: 'refusal' },
          usage,
        },
      ]),
    ).toBe(NOTICE);
  });

  it('closes a reply cut off by a refusal with the notice', async () => {
    expect(
      await reply([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Liều dùng' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'content-filter', raw: 'refusal' },
          usage,
        },
      ]),
    ).toBe(`Liều dùng\n\n${NOTICE}`);
  });

  it('leaves a normal reply untouched', async () => {
    expect(
      await reply([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Đậu hũ sốt cà.' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage,
        },
      ]),
    ).toBe('Đậu hũ sốt cà.');
  });
});
