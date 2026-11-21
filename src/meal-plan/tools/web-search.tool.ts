import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { runtimeConfig } from '../../config/runtime-config.js';

const MAX_REASON_LENGTH = 200;

/**
 * Asks the user for permission to search the web. It has no `execute`, so the
 * agent stops on it and the client shows a consent card with the reason; the
 * user's answer comes back as the next turn with `allowWebSearch`.
 */
export function requestWebSearchTool() {
  return tool({
    description:
      'Xin người dùng cho phép tìm thông tin trên web. Chỉ gọi khi searchKnowledge và searchRecipes không đủ để trả lời và câu hỏi thật sự cần thông tin bên ngoài. Gọi xong thì dừng, không trả lời thêm.',
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(MAX_REASON_LENGTH)
        .describe(
          'Một câu ngắn bằng tiếng Việt: cần tìm gì trên web và vì sao',
        ),
    }),
  });
}

/**
 * OpenRouter's `openrouter:web_search` server tool: OpenRouter runs the
 * searches and returns the results to the model as `url_citation`
 * annotations, which reach the client as `source-url` parts.
 *
 * Built by hand because `@openrouter/ai-sdk-provider`'s `tools.webSearch`
 * flattens its options to the top level of the tool, where OpenRouter ignores
 * them; the server tool reads them from `parameters`.
 *
 * Defaults are the cheapest setup that still reads Vietnamese well: Parallel's
 * `fast` mode with a small context (about $0.002 a turn with search, against
 * about $0.014 on Exa's defaults, measured 2026-11-21).
 */
export function webSearchTool(): Tool {
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
  };
}
