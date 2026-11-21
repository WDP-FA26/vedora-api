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
