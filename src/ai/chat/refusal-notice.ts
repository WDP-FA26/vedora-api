import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

export function refusalNotice<TOOLS extends ToolSet>(
  notice: string,
  onRefusal?: () => void,
): StreamTextTransform<TOOLS> {
  return () => {
    let stepHasText = false;
    let noticeCount = 0;

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === 'start-step') stepHasText = false;
        if (chunk.type === 'text-delta' && chunk.text.trim() !== '') {
          stepHasText = true;
        }
        if (
          chunk.type === 'finish-step' &&
          chunk.finishReason === 'content-filter'
        ) {
          noticeCount += 1;
          onRefusal?.();
          const id = `refusal-notice-${noticeCount}`;
          const text = stepHasText ? `\n\n${notice}` : notice;
          controller.enqueue({ type: 'text-start', id });
          controller.enqueue({ type: 'text-delta', id, text });
          controller.enqueue({ type: 'text-end', id });
        }
        controller.enqueue(chunk);
      },
    });
  };
}
