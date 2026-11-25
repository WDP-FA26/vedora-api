import { tool } from 'ai';
import { z } from 'zod';

/**
 * Voice-mode only: ends the call once the voice model has said goodbye. The API
 * only records the decision; the browser hangs up when the farewell finishes.
 */
export function endCallTool() {
  return tool({
    description:
      'End the voice call after your reply is spoken. Use it when the user says goodbye or clearly wants to stop talking, such as "tạm biệt", "thôi nhé, cảm ơn", "cúp máy đi". Your reply is the farewell, so keep it to one warm sentence. When the user still waits for something you are doing, or only pauses or thanks you mid-conversation, keep the call open.',
    inputSchema: z.object({}),
    execute: () => ({ ended: true }),
    toModelOutput: () => ({
      type: 'text',
      value:
        'Đã ghi nhận: cuộc gọi sẽ tự đóng sau câu trả lời này, không cần gọi endCall thêm. Giờ chỉ viết câu chào tạm biệt.',
    }),
  });
}
