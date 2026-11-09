import type { ModerationVerdict } from '../../../ai/guardrails/guardrail.js';
import type { BlogRefusal } from '../../../ai/guardrails/policies/blog-assistant.js';

export const BLOG_ASSISTANT_REFUSALS: Record<BlogRefusal, string> = {
  unsupported_language:
    'Mình chỉ hiểu tiếng Việt và tiếng Anh thôi. Bạn nhắn lại bằng một trong hai ngôn ngữ này nhé. (I can only reply in Vietnamese or English.)',
  self_harm:
    'Mình không thể viết nội dung khuyến khích nhịn ăn kéo dài hay giảm cân nguy hiểm. Nếu bạn đang gặp khó khăn, hãy nói chuyện với bác sĩ hoặc người thân bạn tin tưởng nhé; khi khẩn cấp, gọi ngay 115.',
  injection:
    'Mình chỉ giúp bạn soạn và chỉnh sửa bài blog thôi. Bạn muốn mình sửa đoạn nào, hay tạo ảnh minh hoạ gì cho bài không?',
  harmful:
    'Mình không thể giúp yêu cầu này. Nếu bạn cần viết hay chỉnh sửa bài blog về món ăn thực vật, mình sẵn sàng hỗ trợ nhé.',
};

export function blogRefusal(verdict: ModerationVerdict): BlogRefusal | null {
  return verdict === 'allow' || verdict === 'off_topic' ? null : verdict;
}
