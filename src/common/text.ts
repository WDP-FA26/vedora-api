export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FENCE_LINE = /^\s*(```|~~~)/;
const INLINE_MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?[^)]*\)/g;
const REF_MARKDOWN_IMAGE = /!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g;
const REF_DEFINITION = /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s|$)/;

/** Extracts unique media URLs referenced by Markdown images outside code fences. */
export function extractMarkdownMediaUrls(markdown: string): string[] {
  const definitions = new Map<string, string>();
  const proseLines: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    proseLines.push(line);
    const def = REF_DEFINITION.exec(line);
    if (def?.[1] && def[2]) {
      definitions.set(def[1].trim().toLowerCase(), def[2]);
    }
  }
  const prose = proseLines.join('\n');
  const urls: string[] = [];
  const pushUnique = (url: string | undefined) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const match of prose.matchAll(INLINE_MARKDOWN_IMAGE)) {
    pushUnique(match[1]);
  }
  if (definitions.size > 0) {
    for (const match of prose.matchAll(REF_MARKDOWN_IMAGE)) {
      const label = (match[2] || match[1] || '').trim().toLowerCase();
      pushUnique(definitions.get(label));
    }
  }
  return urls;
}
