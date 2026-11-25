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
 * What a voice turn hands GPT-Live instead of the chat refusal, for verdicts that only
 * mean "not a planner task". GPT-Live speaks for itself, so it gets the fact and room to
 * answer small talk or what it already knows (such as today's date) like a person would.
 * The other verdicts keep their fixed wording.
 */
export const VOICE_PLANNER_REFUSALS: Partial<
  Record<Exclude<ModerationVerdict, 'allow'>, string>
> = {
  off_topic:
    'Backend không xử lý câu này vì nó nằm ngoài thực đơn và dinh dưỡng. Nếu đó là chuyện phiếm hay điều có sẵn trong cuộc trò chuyện (như hôm nay là ngày nào), cứ trả lời tự nhiên; còn không thì nói nhẹ nhàng rằng mình chỉ lo phần ăn uống.',
  injection:
    'Backend không xử lý câu này vì nó nằm ngoài thực đơn và dinh dưỡng.',
};
