import { runtimeConfig } from '../../config/runtime-config.js';

/** Only allowlisted billing metadata survives; never persist prompts, headers or outputs. */
export function metadataText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 200) return null;
  // eslint-disable-next-line no-control-regex -- rejects control characters
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function metricCount(value: unknown): number | null {
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
  cacheWriteTokens: number | null = null;
  failed = false;
}

export type CostPayloadParser = (
  payload: unknown,
  observation: CostObservation,
) => void;

/** Streaming parser bounds memory, including image/base64 responses and oversized SSE lines. */
export class CostResponseParser {
  readonly observation = new CostObservation();
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private oversized = false;
  private skippingLine = false;

  constructor(
    private readonly sse: boolean,
    private readonly parsePayload: CostPayloadParser,
  ) {}

  write(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!this.sse) {
      if (this.oversized) return;
      if (
        this.buffer.length + text.length >
        runtimeConfig.AI_COST_JSON_MAX_CHARS
      ) {
        this.buffer = '';
        this.oversized = true;
        return;
      }
      this.buffer += text;
      return;
    }
    for (const fragment of text.split(/(?<=\n)/)) {
      if (!this.skippingLine) this.buffer += fragment;
      if (this.buffer.length > runtimeConfig.AI_COST_SSE_LINE_MAX_CHARS) {
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
    } else if (!this.oversized) {
      this.parse(this.buffer);
    }
    this.buffer = '';
  }

  private line(line: string): void {
    if (line.startsWith('data:')) this.parse(line.slice(5).trim());
  }

  private parse(value: string): void {
    try {
      this.parsePayload(JSON.parse(value), this.observation);
    } catch {
      /* Missing metadata is unknown, never free. */
    }
  }
}
