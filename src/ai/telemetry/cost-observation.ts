/** Only allowlisted billing metadata survives; never persist prompts, headers or outputs. */
export function metadataText(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    ? value
    : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function costValue(value: unknown): string | null {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' &&
    value.length <= 80 &&
    /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value))
    ? value
    : null;
}
export class CostObservation {
  generationId: string | null = null;
  resolvedModel: string | null = null;
  provider: string | null = null;
  costUsd: string | null = null;
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  reasoningTokens: number | null = null;
  cachedTokens: number | null = null;
  failed = false;
  accept(value: unknown): void {
    const root = object(value),
      response = object(root.response);
    const data = Object.keys(response).length ? response : root;
    const usage = object(data.usage);
    this.generationId = metadataText(data.id) ?? this.generationId;
    this.resolvedModel = metadataText(data.model) ?? this.resolvedModel;
    this.provider = metadataText(data.provider) ?? this.provider;
    this.costUsd = costValue(usage.cost) ?? this.costUsd;
    this.inputTokens =
      count(usage.prompt_tokens ?? usage.input_tokens) ?? this.inputTokens;
    this.outputTokens =
      count(usage.completion_tokens ?? usage.output_tokens) ??
      this.outputTokens;
    this.reasoningTokens =
      count(
        object(usage.completion_tokens_details ?? usage.output_tokens_details)
          .reasoning_tokens,
      ) ?? this.reasoningTokens;
    this.cachedTokens =
      count(
        object(usage.prompt_tokens_details ?? usage.input_tokens_details)
          .cached_tokens,
      ) ?? this.cachedTokens;
    if (
      root.error ||
      data.error ||
      root.type === 'error' ||
      root.type === 'response.failed'
    )
      this.failed = true;
  }
}

/** Streaming parser bounds memory, including image/base64 responses and oversized SSE lines. */
export class CostResponseParser {
  readonly observation = new CostObservation();
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private oversized = false;
  private skippingLine = false;
  constructor(private readonly sse: boolean) {}
  write(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!this.sse) {
      if (this.oversized) return;
      if (this.buffer.length + text.length > 16 * 1024 * 1024) {
        this.buffer = '';
        this.oversized = true;
        return;
      }
      this.buffer += text;
      return;
    }
    for (const fragment of text.split(/(?<=\n)/)) {
      if (!this.skippingLine) this.buffer += fragment;
      if (this.buffer.length > 1024 * 1024) {
        this.buffer = '';
        this.skippingLine = true;
      }
      if (fragment.endsWith('\n')) {
        if (!this.skippingLine) this.line(this.buffer.trim());
        this.buffer = '';
        this.skippingLine = false;
      }
    }
  }
  finish(): void {
    this.buffer += this.decoder.decode();
    if (this.sse) {
      if (!this.skippingLine) this.line(this.buffer.trim());
    } else if (!this.oversized) this.parse(this.buffer);
    this.buffer = '';
  }
  private line(line: string): void {
    if (line.startsWith('data:')) this.parse(line.slice(5).trim());
  }
  private parse(value: string): void {
    try {
      this.observation.accept(JSON.parse(value));
    } catch {
      /* Missing metadata is unknown, never free. */
    }
  }
}
