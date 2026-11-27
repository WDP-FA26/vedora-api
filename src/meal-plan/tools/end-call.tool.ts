import { tool } from 'ai';
import { z } from 'zod';

/**
 * Voice-mode only: ends the call once the voice model has said goodbye. The API
 * only records the decision; the browser hangs up when the farewell finishes.
 */
export function endCallTool() {
  return tool({
    description:
      'End the voice call automatically after your farewell is spoken — no confirmation needed. Call it immediately whenever the user says goodbye or expresses clear intent to end, hang up, or turn off the voice conversation itself. Keep the call open when the user is closing a screen panel (use setScreen with view "calendar" instead), stopping or undoing an edit while continuing the call, still waiting on a task, or thanking you mid-conversation.',
    inputSchema: z.object({}),
    execute: () => ({ ended: true }),
    toModelOutput: () => ({
      type: 'text',
      value:
        'Đã ghi nhận: cuộc gọi sẽ tự đóng sau câu trả lời này, không cần gọi endCall thêm. Giờ chỉ viết câu chào tạm biệt.',
    }),
  });
}
