import type {
  EmbeddingModelV4Middleware,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4Source,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResult,
} from '@ai-sdk/provider';
import { runtimeConfig } from '../../../config/runtime-config.js';
import type { ReasoningEffort } from '../../reasoning.js';
import { asRecord } from '../provider-shared.js';

const PARALLEL_SEARCH_TOOL_ID = 'gateway.parallel_search';
const EMBEDDING_BATCH_SIZE = runtimeConfig.AI_EMBEDDING_BATCH_SIZE;

/**
 * The URLs a Parallel search returned, as `url` sources: OpenRouter reports
 * its search results as sources, and callers read citations from there.
 */
function searchSources(
  part: LanguageModelV4ToolResult,
  searchToolNames: ReadonlySet<string>,
): LanguageModelV4Source[] {
  if (!searchToolNames.has(part.toolName)) return [];
  const results = asRecord(part.result)?.results;
  if (!Array.isArray(results)) return [];
  const sources: LanguageModelV4Source[] = [];
  for (const [index, item] of results.entries()) {
    const result = asRecord(item);
    if (typeof result?.url !== 'string') continue;
    sources.push({
      type: 'source',
      sourceType: 'url',
      id: `${part.toolCallId}-${index}`,
      url: result.url,
      ...(typeof result.title === 'string' ? { title: result.title } : {}),
    });
  }
  return sources;
}

function searchToolNames(params: LanguageModelV4CallOptions): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools ?? []) {
    if (tool.type === 'provider' && tool.id === PARALLEL_SEARCH_TOOL_ID)
      names.add(tool.name);
  }
  return names;
}

function withSearchSources(
  content: LanguageModelV4Content[],
  names: ReadonlySet<string>,
): LanguageModelV4Content[] {
  if (names.size === 0) return content;
  const result: LanguageModelV4Content[] = [];
  for (const part of content) {
    result.push(part);
    if (part.type === 'tool-result') result.push(...searchSources(part, names));
  }
  return result;
}

/** Adds a `url` source after each Parallel search result, in results and streams. */
export const searchSourcesMiddleware: LanguageModelV4Middleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: withSearchSources(result.content, searchToolNames(params)),
    };
  },
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    const names = searchToolNames(params);
    if (names.size === 0) return result;
    const addSources = new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >({
      transform(part, controller) {
        controller.enqueue(part);
        if (part.type !== 'tool-result') return;
        for (const source of searchSources(part, names))
          controller.enqueue(source);
      },
    });
    return { ...result, stream: result.stream.pipeThrough(addSources) };
  },
};

/**
 * The model's effort for calls that set none. `defaultSettingsMiddleware`
 * has no `reasoning` setting, so this one fills it in.
 */
export function defaultReasoningMiddleware(
  effort: ReasoningEffort,
): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    transformParams: ({ params }) => {
      if (params.reasoning && params.reasoning !== 'provider-default')
        return Promise.resolve(params);
      return Promise.resolve({ ...params, reasoning: effort });
    },
  };
}

/** Embedding size as the AI SDK's `dimensions` option, which the Gateway maps per provider. */
export function gatewayEmbeddingMiddleware(
  dimensions: number,
): EmbeddingModelV4Middleware {
  return {
    specificationVersion: 'v4',
    overrideMaxEmbeddingsPerCall: () => EMBEDDING_BATCH_SIZE,
    transformParams: ({ params }) => Promise.resolve({ ...params, dimensions }),
  };
}
