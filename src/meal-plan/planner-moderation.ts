import { setTimeout as sleep } from 'node:timers/promises';
import type { LanguageModel } from 'ai';
import {
  moderate,
  type ModerationVerdict,
} from '../nutrition-chat/nutrition-chat.moderation';

const TIMEOUT_MS = 4000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

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
 * The nutrition chat's classifier (or another `policy`), with the same short
 * backoff (the provider sometimes answers 429). Throws when no verdict
 * arrives in time.
 */
export async function moderatePlannerMessage(
  model: LanguageModel,
  text: string,
  abortSignal: AbortSignal,
  policy?: string,
): Promise<ModerationVerdict> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([abortSignal, timeout]);
  for (let attempt = 1; ; attempt++) {
    try {
      return await moderate(model, text, signal, policy);
    } catch (error) {
      if (attempt >= ATTEMPTS || signal.aborted) throw error;
      await sleep(RETRY_DELAY_MS * attempt, undefined, { signal }).catch(
        () => undefined,
      );
      if (signal.aborted) throw error;
    }
  }
}
