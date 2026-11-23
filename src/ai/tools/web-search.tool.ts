import { type Tool } from 'ai';
import { z } from 'zod';
import { runtimeConfig } from '../../config/runtime-config.js';

/**
 * OpenRouter's `openrouter:web_search` server tool: OpenRouter runs the
 * searches and returns the results to the model as `url_citation`
 * annotations, which appear in SDK responses as `url` sources.
 *
 * Built by hand because `@openrouter/ai-sdk-provider`'s `tools.webSearch`
 * flattens its options to the top level of the tool, where OpenRouter ignores
 * them; the server tool reads them from `parameters`.
 */
export function webSearchTool(): Tool<Record<string, never>, unknown> {
  return {
    type: 'provider',
    id: 'openrouter.web_search',
    isProviderExecuted: true,
    args: {
      parameters: {
        engine: runtimeConfig.PLANNER_WEB_SEARCH_ENGINE,
        mode: runtimeConfig.PLANNER_WEB_SEARCH_MODE,
        search_context_size: runtimeConfig.PLANNER_WEB_SEARCH_CONTEXT_SIZE,
        max_results: runtimeConfig.PLANNER_WEB_SEARCH_MAX_RESULTS,
        max_total_results: runtimeConfig.PLANNER_WEB_SEARCH_MAX_TOTAL_RESULTS,
        max_uses: runtimeConfig.PLANNER_WEB_SEARCH_MAX_USES,
      },
    },
    inputSchema: z.object({}),
    // Results arrive as url sources; this only gives the tool a concrete type.
    outputSchema: z.unknown(),
  };
}
