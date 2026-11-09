import type { UIMessageChunk } from 'ai';
import { mockDeep } from 'vitest-mock-extended';
import { quotaStream } from '../../../src/subscriptions/quota-stream.js';
import { AiUsageService } from '../../../src/subscriptions/ai-usage.service.js';

const ticket = { id: 'request', token: 'lease', hash: 'payload' };
const source = (chunks: UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
describe('AI stream quota settlement', () => {
  it('commits before exposing finish so editor continuations cannot race it', async () => {
    const usage = mockDeep<AiUsageService>();
    usage.complete.mockResolvedValue();
    const reader = quotaStream(
      source([{ type: 'finish' }]),
      usage,
      ticket,
    ).getReader();
    expect((await reader.read()).value).toMatchObject({ type: 'finish' });
    expect(usage.complete).toHaveBeenCalledExactlyOnceWith(ticket);
    await reader.read();
    expect(usage.complete).toHaveBeenCalledOnce();
    expect(usage.refund).not.toHaveBeenCalled();
  });
  it('refunds a model error once and does not turn its finish into a charge', async () => {
    const usage = mockDeep<AiUsageService>();
    usage.refund.mockResolvedValue();
    const reader = quotaStream(
      source([
        { type: 'error', errorText: 'provider failed' },
        { type: 'finish' },
      ]),
      usage,
      ticket,
    ).getReader();
    while (!(await reader.read()).done) {
      /* Drain the stream as the controller does. */
    }
    expect(usage.refund).toHaveBeenCalledExactlyOnceWith(ticket);
    expect(usage.complete).not.toHaveBeenCalled();
  });
  it('releases a reservation when the client cancels before completion', async () => {
    const usage = mockDeep<AiUsageService>();
    usage.refund.mockResolvedValue();
    const reader = quotaStream(
      new ReadableStream<UIMessageChunk>(),
      usage,
      ticket,
    ).getReader();
    await reader.cancel();
    expect(usage.refund).toHaveBeenCalledExactlyOnceWith(ticket);
    expect(usage.complete).not.toHaveBeenCalled();
  });
});
