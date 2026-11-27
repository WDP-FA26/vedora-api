import type { UIMessageChunk } from 'ai';
import type { AiUsageService, UsageTicket } from './ai-usage.service.js';

export function quotaStream(
  stream: ReadableStream<UIMessageChunk>,
  usage: AiUsageService,
  ticket: UsageTicket,
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader();
  let settled = false,
    failed = false;
  const settle = async (success: boolean) => {
    if (settled) return;
    settled = true;
    if (success) await usage.complete(ticket);
    else await usage.refund(ticket);
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          await settle(!failed);
          controller.close();
          return;
        }
        if (value.type === 'error' || value.type === 'abort') {
          failed = true;
          await settle(false);
        }
        if (value.type === 'finish') await settle(!failed);
        controller.enqueue(value);
      } catch (error) {
        await settle(false);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settle(false);
      }
    },
  });
}
