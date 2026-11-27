import { tool } from 'ai';
import type { MealPlannerChatHistoryService } from '../meal-planner-chat-history.service.js';
import { DAY_NAMES } from '../meal-planner.prompt.js';
import { z } from 'zod';

export function undoLastChangeTool(
  history: MealPlannerChatHistoryService,
  userId: string,
  threadId: string,
) {
  return tool({
    description:
      'Undo the newest change you saved to the plan in this conversation (dishes filled, swapped, balanced or removed), putting those days back as they were. Each call undoes one earlier change. Use it when the user asks to undo, go back, or cancel a change already made. It does not touch the food diary or body metrics.',
    inputSchema: z.object({
      done: z
        .boolean()
        .optional()
        .describe(
          'Set to true when the user only asked to undo and needs no further advice',
        ),
    }),
    execute: async (input) => {
      const result = await history.undoLatestChange(userId, threadId);
      return input.done === true ? { ...result, done: true } : result;
    },
    toModelOutput: ({ output }) => {
      if (output.messageId === null || output.weeks.length === 0) {
        return {
          type: 'text',
          value:
            'Không còn thay đổi thực đơn nào trong cuộc trò chuyện này để hoàn tác.',
        };
      }
      const lines: string[] = [];
      for (const week of output.weeks) {
        const restored = week.restored.map((day) => DAY_NAMES[day]).join(', ');
        const skipped = week.skipped.map((day) => DAY_NAMES[day]).join(', ');
        let line = `Tuần ${week.weekStart}: đã đưa về như trước ${restored || 'không ngày nào'}`;
        if (skipped) line += `; ${skipped} đã qua nên giữ nguyên`;
        if (week.droppedDishes > 0) {
          line += `; ${week.droppedDishes} món không còn dùng được nên bỏ ra`;
        }
        lines.push(`${line}.`);
      }
      return { type: 'text', value: lines.join(' ') };
    },
  });
}
