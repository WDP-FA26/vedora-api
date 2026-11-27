import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

/**
 * Claude Haiku 5.5's safety classifiers can decline a step (`finishReason:
 * 'content-filter'`), with no server-side fallback. The step then ends with no
 * reply or a partial one, so this adds `notice` as the step's closing text:
 * the user (or the voice model speaking the reply) always hears why it stopped.
 * `onRefusal` runs once per declined step, so callers can count refusals.
 */
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
