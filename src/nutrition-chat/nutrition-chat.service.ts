import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  APICallError,
  createUIMessageStream,
  type LanguageModel,
  RetryError,
  toUIMessageStream,
} from 'ai';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service';
import type { ChatMessageDto } from './dto/nutrition-chat.dto';
import { NutritionAgent, type ReasoningEffort } from './nutrition-chat.agent';
import { moderate, type ModerationVerdict } from './nutrition-chat.moderation';
import { replyFilter } from './reply-filter';

const SEARCH_TIMEOUT_MS = 5000;
const MODERATION_TIMEOUT_MS = 4000;
const MODERATION_ATTEMPTS = 2;

const REFUSALS: Record<Exclude<ModerationVerdict, 'allow'>, string> = {
  off_topic:
    'Mình chỉ trả lời các câu hỏi về dinh dưỡng và chế độ ăn từ thực vật thôi. Bạn muốn hỏi gì về chủ đề này không?',
  self_harm:
    'Mình rất lo khi nghe bạn nói vậy. Nhịn ăn kéo dài hay ép cân quá mức có thể nguy hiểm đến tính mạng. Bạn hãy nói chuyện với bác sĩ hoặc người thân bạn tin tưởng nhé; nếu đang gặp nguy hiểm, gọi ngay 115.',
  injection:
    'Mình chỉ hỗ trợ các câu hỏi về dinh dưỡng và bữa ăn từ thực vật thôi. Bạn muốn hỏi gì về chủ đề này không?',
  harmful:
    'Mình không thể giúp yêu cầu này. Nếu bạn có câu hỏi về dinh dưỡng hay món ăn thực vật, mình sẵn sàng hỗ trợ nhé.',
};

type ChatErrorCode = 'RATE_LIMITED' | 'MODEL_ERROR';

function failedCall(error: unknown): APICallError | null {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(cause) ? cause : null;
}

export function chatErrorCode(error: unknown): ChatErrorCode {
  return failedCall(error)?.statusCode === 429 ? 'RATE_LIMITED' : 'MODEL_ERROR';
}

@Injectable()
export class NutritionChatService {
  private readonly logger = new Logger(NutritionChatService.name);

  private readonly agent: NutritionAgent;
  private readonly moderationModel: LanguageModel;

  constructor(configService: ConfigService, knowledge: KnowledgeSearchService) {
    const apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.agent = new NutritionAgent({
      apiKey,
      modelId: configService.get<string>('OPENROUTER_MODEL', 'openrouter/auto'),
      reasoningEffort: configService.get<ReasoningEffort>(
        'OPENROUTER_REASONING_EFFORT',
        'low',
      ),
      knowledge,
    });
    this.moderationModel = createOpenRouter({ apiKey })(
      configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        'openai/gpt-oss-safeguard-20b',
      ),
      { reasoning: { effort: 'low', exclude: true } },
    );
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
        const call = failedCall(error);
        this.logger.error(
          `OpenRouter stream failed: ${call?.statusCode ?? '-'} ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return chatErrorCode(error);
      },
    });
  }

  // one immediate retry: the only provider sometimes answers 429, and the
  // SDK's backoff would outlast the timeout
  private async moderate(
    text: string,
    abortSignal: AbortSignal,
  ): Promise<ModerationVerdict> {
    const timeout = AbortSignal.timeout(MODERATION_TIMEOUT_MS);
    const signal = AbortSignal.any([abortSignal, timeout]);
    for (let attempt = 1; ; attempt++) {
      try {
        return await moderate(this.moderationModel, text, signal);
      } catch (error) {
        if (abortSignal.aborted) throw error;
        if (attempt < MODERATION_ATTEMPTS && !timeout.aborted) continue;
        this.logger.error(`Moderation failed: ${String(error)}`);
        throw new ServiceUnavailableException('Moderation is unavailable');
      }
    }
  }
}

function cannedReply(text: string) {
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: { refused: true } });
      writer.write({ type: 'text-start', id: 'reply' });
      writer.write({ type: 'text-delta', id: 'reply', delta: text });
      writer.write({ type: 'text-end', id: 'reply' });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
}
