import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type LanguageModel, toUIMessageStream } from 'ai';
import { cannedReply } from '../ai/chat/canned-reply';
import { chatErrorCode, failedStatus } from '../ai/chat/errors';
import { replyFilter } from '../ai/chat/reply-filter';
import {
  moderateWithRetry,
  type ModerationVerdict,
} from '../ai/moderation/moderation';
import { NUTRITION_POLICY } from '../ai/moderation/policies/nutrition';
import {
  chatModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MODERATION_MODEL,
} from '../ai/openrouter';
import type { ReasoningEffort } from '../ai/reasoning';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service';
import type { ChatMessageDto } from './dto/nutrition-chat.dto';
import { NutritionAgent } from './nutrition-chat.agent';

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
  private readonly moderationModel: LanguageModel;

  constructor(configService: ConfigService, knowledge: KnowledgeSearchService) {
    const apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.agent = new NutritionAgent({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODEL',
        DEFAULT_CHAT_MODEL,
      ),
      reasoningEffort: configService.get<ReasoningEffort>(
        'OPENROUTER_REASONING_EFFORT',
        'low',
      ),
      knowledge,
    });
    this.moderationModel = chatModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        DEFAULT_MODERATION_MODEL,
      ),
      reasoningEffort: 'low',
    });
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

  // our own short backoff: the only provider sometimes answers 429, and the
  // SDK's backoff would outlast the timeout
  private async moderate(
    text: string,
    abortSignal: AbortSignal,
  ): Promise<ModerationVerdict> {
    try {
      return await moderateWithRetry(
        this.moderationModel,
        text,
        abortSignal,
        NUTRITION_POLICY,
      );
    } catch (error) {
      if (abortSignal.aborted) throw error;
      this.logger.error(`Moderation failed: ${String(error)}`);
      throw new ServiceUnavailableException('Moderation is unavailable');
    }
  }
}
