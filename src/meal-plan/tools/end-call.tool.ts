import { tool } from 'ai';
import { z } from 'zod';

/**
 * Voice-mode only: ends the call once the voice model has said goodbye. The API
 * only records the decision; the browser hangs up when the farewell finishes.
 */
export function endCallTool() {
  return tool({
    description:
      'End the voice call automatically after your farewell is spoken — no confirmation needed. Call it immediately whenever the user says goodbye or expresses any intent to stop, close, or turn off the voice call, conversation, or assistant (for example: "tạm biệt", "tắt cuộc hội thoại", "đóng cuộc trò chuyện", "tắt trợ lý", "dừng nói chuyện", "thôi nhé, cảm ơn", "cúp máy đi", "xong rồi"). Keep the call open only when the user is closing a UI panel (use setScreen with view "calendar" instead), still waiting on a task, or just pausing/thanking you mid-conversation.',
    inputSchema: z.object({}),
    execute: () => ({ ended: true }),
    toModelOutput: () => ({
      type: 'text',
      value:
        'Đã ghi nhận: cuộc gọi sẽ tự đóng sau câu trả lời này, không cần gọi endCall thêm. Giờ chỉ viết câu chào tạm biệt.',
    }),
  });
}
