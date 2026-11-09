import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/ai';
import {
  type Experimental_EvaluationModel,
  type LanguageModel,
  toUIMessageStream,
} from 'ai';
import { cannedReply } from '../ai/chat/canned-reply.js';
import { chatErrorCode, failedStatus } from '../ai/chat/errors.js';
import { replyFilter } from '../ai/chat/reply-filter.js';
import {
  MODERATION_MODEL,
  type ModerationVerdict,
} from '../ai/guardrails/guardrail.js';
import { decide } from '../common/decision/decision.js';
import { NUTRITION_POLICY } from '../ai/guardrails/policies/nutrition.js';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import type { ChatMessageDto } from './dto/nutrition-chat.dto.js';
import { NutritionAgent } from './nutrition-chat.agent.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

const SEARCH_TIMEOUT_MS = 5000;

const REFUSALS: Record<Exclude<ModerationVerdict, 'allow'>, string> = {
  off_topic:
    'Mình chỉ trả lời các câu hỏi về dinh dưỡng và chế độ ăn từ thực vật thôi. Bạn muốn hỏi gì về chủ đề này không?',
  unsupported_language:
    'Mình chỉ hiểu tiếng Việt và tiếng Anh thôi. Bạn hỏi lại bằng một trong hai ngôn ngữ này nhé. (I can only reply in Vietnamese or English.)',
  self_harm:
    'Mình rất lo khi nghe bạn nói vậy. Nhịn ăn kéo dài hay ép cân quá mức có thể nguy hiểm đến tính mạng. Bạn hãy nói chuyện với bác sĩ hoặc người thân bạn tin tưởng nhé; nếu đang gặp nguy hiểm, gọi ngay 115.',
  injection:
    'Mình chỉ hỗ trợ các câu hỏi về dinh dưỡng và bữa ăn từ thực vật thôi. Bạn muốn hỏi gì về chủ đề này không?',
  harmful:
    'Mình không thể giúp yêu cầu này. Nếu bạn có câu hỏi về dinh dưỡng hay món ăn thực vật, mình sẵn sàng hỗ trợ nhé.',
};

@Injectable()
export class NutritionChatService {
  private readonly logger = new Logger(NutritionChatService.name);

  private readonly agent: NutritionAgent;

  constructor(
    @Inject(MODERATION_MODEL)
    private readonly moderator: Experimental_EvaluationModel,
    @InjectModel() model: LanguageModel,
    knowledge: KnowledgeSearchService,
  ) {
    this.agent = new NutritionAgent({ model, knowledge });
  }

  async stream(messages: ChatMessageDto[], abortSignal: AbortSignal) {
    const verdict = await this.moderate(
      messages.at(-1)?.text ?? '',
      abortSignal,
    );
    if (verdict !== 'allow') {
      this.logger.warn(`Moderation answered ${verdict}`);
      return cannedReply(REFUSALS[verdict]);
    }

    const result = await this.agent.stream({
      messages: messages.map(({ role, text }) => ({ role, content: text })),
      abortSignal,
      timeout: { tools: { searchKnowledgeMs: SEARCH_TIMEOUT_MS } },
      experimental_transform: replyFilter(),
    });

    return toUIMessageStream({
      stream: result.stream,
      tools: this.agent.tools,
      onError: (error) => {
        const status = failedStatus(error);
        this.logger.error(
          `OpenRouter stream failed: ${status ?? '-'} ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return chatErrorCode(error);
      },
    });
  }

  private async moderate(
    text: string,
    abortSignal: AbortSignal,
  ): Promise<ModerationVerdict> {
    try {
      const { choice } = await decide(
        this.moderator,
        text,
        abortSignal,
        NUTRITION_POLICY,
      );
      return choice;
    } catch (error) {
      if (abortSignal.aborted) throw error;
      this.logger.error(`Moderation failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Moderation is unavailable',
      );
    }
  }
}
