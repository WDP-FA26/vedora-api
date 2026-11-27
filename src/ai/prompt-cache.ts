import { createHash } from 'node:crypto';
import type { ModelMessage, SystemModelMessage } from 'ai';
import {
  type CacheTtl,
  type CallOptions,
  type ProviderOptions,
} from './providers/ai-provider.interface.js';
import { providerDialect } from './providers/provider-registry.js';
import type { ReasoningEffort } from './reasoning.js';

const MAX_SESSION_ID_LENGTH = 256;

export class PromptCache {
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
  ): ProviderOptions {
    return providerDialect().callOptions({
      sessionId: PromptCache.sessionId(prefix, ...scope),
    }).providerOptions;
  }

  static system(content: string, ttl: CacheTtl = '1h'): SystemModelMessage {
    return {
      role: 'system',
      content,
      providerOptions: providerDialect().cacheBreakpoint(ttl),
    };
  }

  static textPart(
    text: string,
    ttl: CacheTtl = '1h',
  ): { type: 'text'; text: string; providerOptions: ProviderOptions } {
    return {
      type: 'text',
      text,
      providerOptions: providerDialect().cacheBreakpoint(ttl),
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
          PromptCache.textPart(cachedPrefix, ttl),
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
    effort,
  }: {
    session: string;
    scope?: readonly (string | null | undefined)[];
    instructions: string;
    ttl?: CacheTtl;
    enabled?: boolean;
    effort?: ReasoningEffort;
  }): CallOptions & { instructions: string | SystemModelMessage } {
    return {
      instructions: enabled
        ? PromptCache.system(instructions, ttl)
        : instructions,
      ...providerDialect().callOptions({
        sessionId: PromptCache.sessionId(session, ...scope),
        effort,
      }),
    };
  }

  static agent({
    session,
    scope = [],
    instructions,
    systemTtl = '1h',
    historyTtl = '5m',
    effort,
  }: {
    session: string;
    scope?: readonly (string | null | undefined)[];
    instructions: string;
    systemTtl?: CacheTtl;
    historyTtl?: CacheTtl;
    effort?: ReasoningEffort;
  }): CallOptions & { instructions: SystemModelMessage } {
    return {
      instructions: PromptCache.system(instructions, systemTtl),
      ...providerDialect().callOptions({
        sessionId: PromptCache.sessionId(session, ...scope),
        cacheTtl: historyTtl,
        effort,
      }),
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
