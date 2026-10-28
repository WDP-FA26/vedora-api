import { createUIMessageStream } from 'ai';

/** A refusal sent as if it were the assistant's reply, so clients render it. */
export function cannedReply(text: string) {
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: { refused: true } });
      writer.write({ type: 'text-start', id: 'reply' });
      writer.write({ type: 'text-delta', id: 'reply', delta: text });
      writer.write({ type: 'text-end', id: 'reply' });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
}
