/**
 * Calls with OpenRouter's `web_search` server tool need this: OpenRouter
 * ignores `response_format` on them, so `Output.object` cannot be used.
 *
 * The JSON object in a model's text reply, which may be wrapped in a code
 * fence or surrounded by prose. Null when there is none or it does not parse:
 * callers validate the result with a schema anyway.
 */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
