import { tool } from 'ai';
import { z } from 'zod';

export { webSearchTool } from '../../ai/tools/web-search.tool.js';

const MAX_REASON_LENGTH = 200;

/**
 * Asks the user for permission to search the web. It has no `execute`, so the
 * agent stops on it and the client shows a consent card with the reason; the
 * user's answer comes back as the next turn with `allowWebSearch`.
 */
export function requestWebSearchTool() {
  return tool({
    description:
      'Ask the user for permission to search the web. Call it when the user asks about a dish, ingredient, product or fact that searchRecipes and searchKnowledge do not cover, so they get information they can use instead of only hearing that Vedora does not have it. When you also suggest similar Vedora dishes, still offer the search in the same turn. Stop after calling it: the user answers in the next turn.',
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(MAX_REASON_LENGTH)
        .describe(
          'One short sentence in Vietnamese, shown to the user: what to look up on the web and why',
        ),
    }),
    outputSchema: z.object({
      approved: z.boolean(),
    }),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.approved
        ? 'Người dùng đã cho phép tìm trên web.'
        : 'Người dùng không cho phép tìm trên web.',
    }),
  });
}
