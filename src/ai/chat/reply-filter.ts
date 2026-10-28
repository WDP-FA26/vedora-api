import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

const FENCE = /^\s*(```|~~~)/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL = /<?\bhttps?:\/\/[^\s>)]*>?/gi;
const HTML_TAG = /<\/?[a-z][^>]*>/gi;
// a line holding one of these waits until it is complete, so a split
// construct (a fence, an image, a link or a tag) is never half-sent
const MARKUP_START = /[`~![<]/;

function clean(text: string): string {
  return text
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(URL, '')
    .replace(HTML_TAG, '');
}

/** Drops code blocks and strips images, links, URLs and HTML from the reply as it streams. */
export function replyFilter<
  TOOLS extends ToolSet,
>(): StreamTextTransform<TOOLS> {
  return () => {
    let pending = '';
    let inFence = false;

    function line(text: string): string | null {
      if (FENCE.test(text)) {
        inFence = !inFence;
        return null;
      }
      return inFence ? null : clean(text);
    }

    function release(): string {
      let out = '';
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const kept = line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (kept !== null) out += `${kept}\n`;
      }
      if (!inFence && !MARKUP_START.test(pending)) {
        const cut = pending.search(/\s\S*$/) + 1;
        out += clean(pending.slice(0, cut));
        pending = pending.slice(cut);
      }
      return out;
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          pending += chunk.text;
          const text = release();
          if (text) controller.enqueue({ ...chunk, text });
          return;
        }
        if (chunk.type === 'text-end') {
          const text = line(pending);
          if (text)
            controller.enqueue({ type: 'text-delta', id: chunk.id, text });
          pending = '';
          inFence = false;
        }
        controller.enqueue(chunk);
      },
    });
  };
}
