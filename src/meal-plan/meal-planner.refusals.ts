import type { ModerationVerdict } from '../ai/guardrails/guardrail.js';

export const PLANNER_REFUSALS: Record<
  Exclude<ModerationVerdict, 'allow'>,
  string
> = {
  off_topic:
    'Mình chỉ giúp lên thực đơn và trả lời về dinh dưỡng, món ăn từ thực vật thôi. Bạn muốn chỉnh thực đơn hay hỏi gì về chủ đề này không?',
  unsupported_language:
    'Mình chỉ hiểu tiếng Việt và tiếng Anh thôi. Bạn nhắn lại bằng một trong hai ngôn ngữ này nhé. (I can only reply in Vietnamese or English.)',
  self_harm:
    'Mình rất lo khi nghe bạn nói vậy. Nhịn ăn kéo dài hay ép cân quá mức có thể nguy hiểm đến tính mạng. Bạn hãy nói chuyện với bác sĩ hoặc người thân bạn tin tưởng nhé; nếu đang gặp nguy hiểm, gọi ngay 115.',
  injection:
    'Mình chỉ giúp lên thực đơn và trả lời về dinh dưỡng, món ăn từ thực vật thôi. Bạn muốn chỉnh thực đơn hay hỏi gì về chủ đề này không?',
  harmful:
    'Mình không thể giúp yêu cầu này. Nếu bạn muốn lên thực đơn hay hỏi về món ăn thực vật, mình sẵn sàng hỗ trợ nhé.',
};

/**
 * Said when the model's own safety filter declines a planner turn
 * (`finishReason: 'content-filter'`), which has no server-side fallback.
 */
export const PLANNER_MODEL_DECLINED_REPLY =
  'Yêu cầu này bị bộ lọc an toàn của mô hình AI chặn nên mình không trả lời được. Bạn thử diễn đạt lại, hoặc hỏi mình về thực đơn và món ăn thực vật nhé.';
