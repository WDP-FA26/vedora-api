import { createHash } from 'node:crypto';
import type { ModelMessage, SystemModelMessage } from 'ai';

export type CacheTtl = '5m' | '1h';

export type EphemeralCacheSpec = {
  type: 'ephemeral';
  ttl?: '1h';
};

export type StickyProviderOptions = {
  openrouter: { session_id: string };
};

export type AutoCachedProviderOptions = {
  openrouter: { session_id: string; cacheControl: EphemeralCacheSpec };
};

const MAX_SESSION_ID_LENGTH = 256;

/**
 * Centralizes OpenRouter + Anthropic prompt caching and sticky-session routing:
 * explicit 1h breakpoints for shared static prefixes, optional 5m advancing
 * cache breakpoints for multi-turn agent loops, hashed `session_id` stickiness,
 * user-turn context injection, and cache-safe final-step reminders.
 */
export class OpenRouterCacheControl {
  static ephemeral(ttl: CacheTtl = '1h'): EphemeralCacheSpec {
    if (ttl === '1h') return { type: 'ephemeral', ttl: '1h' };
    return { type: 'ephemeral' };
  }

  static sessionId(
    prefix: string,
    ...scope: readonly (string | null | undefined)[]
  ): string {
    const present: string[] = [];
    for (const part of scope) {
      if (part) present.push(part);
    }
    if (present.length === 0) return prefix.slice(0, MAX_SESSION_ID_LENGTH);
    const digest = createHash('sha256')
      .update(JSON.stringify(present))
      .digest('hex')
      .slice(0, 24);
    return `${prefix}-${digest}`.slice(0, MAX_SESSION_ID_LENGTH);
  }

  static sticky(
    prefix: string,
    ...scope: readonly (string | null | undefined)[]
  ): StickyProviderOptions {
    return {
      openrouter: {
        session_id: OpenRouterCacheControl.sessionId(prefix, ...scope),
      },
    };
  }

  static system(content: string, ttl: CacheTtl = '1h'): SystemModelMessage {
    return {
      role: 'system',
      content,
      providerOptions: {
        openrouter: { cacheControl: OpenRouterCacheControl.ephemeral(ttl) },
      },
    };
  }

  static textPart(
    text: string,
    ttl: CacheTtl = '1h',
  ): {
    type: 'text';
    text: string;
    providerOptions: { openrouter: { cacheControl: EphemeralCacheSpec } };
  } {
    return {
      type: 'text',
      text,
      providerOptions: {
        openrouter: { cacheControl: OpenRouterCacheControl.ephemeral(ttl) },
      },
    };
  }

  static prefixMessages(
    cachedPrefix: string,
    suffix: string,
    ttl: CacheTtl = '1h',
  ): ModelMessage[] {
    return [
      {
        role: 'user',
        content: [
          OpenRouterCacheControl.textPart(cachedPrefix, ttl),
          { type: 'text', text: suffix },
        ],
      },
    ];
  }

  static singleTurn({
    session,
    scope = [],
    instructions,
    ttl = '1h',
    enabled = true,
  }: {
    session: string;
    scope?: readonly (string | null | undefined)[];
    instructions: string;
    ttl?: CacheTtl;
    enabled?: boolean;
  }): {
    instructions: string | SystemModelMessage;
    providerOptions: StickyProviderOptions;
  } {
    return {
      instructions: enabled
        ? OpenRouterCacheControl.system(instructions, ttl)
        : instructions,
      providerOptions: OpenRouterCacheControl.sticky(session, ...scope),
    };
  }

  static agent({
    session,
    scope = [],
    instructions,
    systemTtl = '1h',
    historyTtl = '5m',
  }: {
    session: string;
    scope?: readonly (string | null | undefined)[];
    instructions: string;
    systemTtl?: CacheTtl;
    historyTtl?: CacheTtl;
  }): {
    instructions: SystemModelMessage;
    providerOptions: AutoCachedProviderOptions;
  } {
    return {
      instructions: OpenRouterCacheControl.system(instructions, systemTtl),
      providerOptions: {
        openrouter: {
          session_id: OpenRouterCacheControl.sessionId(session, ...scope),
          cacheControl: OpenRouterCacheControl.ephemeral(historyTtl),
        },
      },
    };
  }

  static withUserContext(
    messages: readonly ModelMessage[],
    contextText: string,
  ): ModelMessage[] {
    const result = [...messages];
    const lastUserIndex = result.findLastIndex(({ role }) => role === 'user');
    const target = result[lastUserIndex];
    if (target?.role !== 'user') return result;
    const content =
      typeof target.content === 'string'
        ? [{ type: 'text' as const, text: target.content }]
        : target.content;
    result[lastUserIndex] = {
      ...target,
      content: [{ type: 'text', text: contextText }, ...content],
    };
    return result;
  }

  static finalStepGuard(maxSteps: number, reminder?: string) {
    return ({
      stepNumber,
      messages,
    }: {
      stepNumber: number;
      messages: ModelMessage[];
    }): { toolChoice?: 'none'; messages?: ModelMessage[] } => {
      if (stepNumber < maxSteps - 1) return {};
      const trimmed = reminder?.trim();
      if (!trimmed) return { toolChoice: 'none' };
      return {
        toolChoice: 'none',
        messages: [
          ...messages,
          {
            role: 'user',
            content: `<system-reminder>${trimmed}</system-reminder>`,
          },
        ],
      };
    };
  }
}
