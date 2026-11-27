export type PromptAttributes = Readonly<Record<string, string | number>>;

export interface PromptTags<Tag extends string> {
  strip(text: string): string;
  data(tag: Tag, text: string, attributes?: PromptAttributes): string;
  inlineData(tag: Tag, text: string, attributes?: PromptAttributes): string;
  wrap(tag: Tag, content: string, attributes?: PromptAttributes): string;
}

const TAG_NAME = /^[a-z][a-z0-9_-]*$/i;

export function promptTags<const Tag extends string>(
  names: readonly Tag[],
): PromptTags<Tag> {
  for (const name of names) {
    if (!TAG_NAME.test(name)) throw new Error(`Invalid prompt tag: ${name}`);
  }
  const pattern = new RegExp(`<\\/?(?:${names.join('|')})\\b[^>]*>?`, 'gi');
  const strip = (text: string): string => text.replace(pattern, '');

  const open = (tag: Tag, attributes?: PromptAttributes): string => {
    if (!attributes) return `<${tag}>`;
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      const safe = strip(String(value)).replaceAll('"', "'");
      pairs.push(`${key}="${safe}"`);
    }
    return `<${tag} ${pairs.join(' ')}>`;
  };

  const wrap = (
    tag: Tag,
    content: string,
    attributes?: PromptAttributes,
  ): string => `${open(tag, attributes)}\n${content}\n</${tag}>`;

  return {
    strip,
    wrap,
    data: (tag, text, attributes) => wrap(tag, strip(text), attributes),
    inlineData: (tag, text, attributes) =>
      `${open(tag, attributes)}${strip(text)}</${tag}>`,
  };
}
