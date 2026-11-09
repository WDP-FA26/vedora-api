import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel as InjectAiModel } from '@nestjs/ai';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  convertToModelMessages,
  type Experimental_EvaluationModel,
  isStepCount,
  isTextUIPart,
  isToolUIPart,
  type LanguageModel,
  safeValidateUIMessages,
  ToolLoopAgent,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { cannedReply } from '../../../ai/chat/canned-reply.js';
import { chatErrorCode } from '../../../ai/chat/errors.js';
import { replyFilter } from '../../../ai/chat/reply-filter.js';
import { MODERATION_MODEL } from '../../../ai/guardrails/guardrail.js';
import { decide } from '../../../common/decision/decision.js';
import {
  AiUsageService,
  type UsageTicket,
} from '../../../subscriptions/ai-usage.service.js';
import { quotaStream } from '../../../subscriptions/quota-stream.js';
import { KnowledgeSearchService } from '../../../knowledge/retrieval/knowledge-search.service.js';
import {
  AiFeature,
  Ingredient,
  Post,
  PostType,
  Recipe,
} from '../../../mongo/models.js';
import {
  type BlogAssistantChatDto,
  type BlogAssistantQuotaDto,
  MAX_SELECTION,
} from '../../dto/blog-ai.dto.js';
import { BLOG_ASSISTANT_POLICY } from '../../../ai/guardrails/policies/blog-assistant.js';
import {
  BLOG_ASSISTANT_REFUSALS,
  blogRefusal,
} from './blog-assistant.moderation.js';
import {
  blogAssistantInstructions,
  type LinkedRecipe,
} from './blog-assistant.prompt.js';
import {
  type BlogAssistantTools,
  blogAssistantTools,
} from './blog-assistant.tools.js';
import { BlogImageGeneratorService } from './blog-image-generator.service.js';
import { FeatureUnavailableException } from '../../../common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../../../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../../../common/exceptions/quota-reached.exception.js';
import { ResourceNotFoundException } from '../../../common/exceptions/resource-not-found.exception.js';

const MAX_STEPS = 8;
const MAX_OUTPUT_TOKENS = 4000;
const SEARCH_TIMEOUT_MS = 5000;

@Injectable()
export class BlogAssistantService {
  private readonly logger = new Logger(BlogAssistantService.name);

  constructor(
    @Inject(MODERATION_MODEL)
    private readonly moderator: Experimental_EvaluationModel,
    @InjectAiModel('blog') private readonly model: LanguageModel,
    private readonly knowledge: KnowledgeSearchService,
    private readonly images: BlogImageGeneratorService,
    private readonly usage: AiUsageService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
  ) {}

  async quota(userId: string): Promise<BlogAssistantQuotaDto> {
    const [messages, images] = await Promise.all([
      this.usage.summary(userId, AiFeature.BLOG_CHAT),
      this.usage.summary(userId, AiFeature.BLOG_IMAGE),
    ]);
    return { messages, images };
  }

  async stream(
    userId: string,
    dto: BlogAssistantChatDto,
    abortSignal: AbortSignal,
  ) {
    abortSignal = AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    const tools = blogAssistantTools(userId, this.knowledge, this.images);
    const messages = await parseMessages(dto.messages, tools);
    const last = messages[messages.length - 1];
    const recipes = dto.blogId
      ? await this.linkedRecipes(userId, dto.blogId)
      : [];

    const userTurn = messages.findLast((message) => message.role === 'user');
    const ticket = await this.usage.consume(userId, AiFeature.BLOG_CHAT, {
      requestId: userTurn?.id,
      // The draft may be saved for the first time between editor tool calls.
      // Bind to the chat session, not a blogId that can appear mid-turn.
      prompt: { parts: userTurn?.parts, sessionId: dto.id },
      input: { messages, editor: dto.editor, blogId: dto.blogId },
      continuation: last.role !== 'user',
    });
    if (!ticket) {
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'Your shared AI text allowance is exhausted',
      );
    }

    try {
      if (last.role === 'user') {
        const { choice: verdict } = await decide(
          this.moderator,
          textOf(last),
          abortSignal,
          BLOG_ASSISTANT_POLICY,
        ).catch((error: unknown) => {
          if (abortSignal.aborted) throw error;
          this.logger.error(`Moderation failed: ${String(error)}`);
          throw new FeatureUnavailableException(
            'SERVICE_UNAVAILABLE',
            'Moderation is unavailable',
          );
        });
        const refusal = blogRefusal(verdict);
        if (refusal) {
          this.logger.warn(`Moderation answered ${verdict}`);
          await this.refund(ticket);
          return cannedReply(BLOG_ASSISTANT_REFUSALS[refusal]);
        }
      }

      const agent = new ToolLoopAgent({
        model: this.model,
        instructions: blogAssistantInstructions(dto.editor, recipes),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        prepareStep: ({ stepNumber }) =>
          stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
      });
      const result = await agent.stream({
        messages: await convertToModelMessages(messages, {
          tools,
          ignoreIncompleteToolCalls: true,
        }),
        abortSignal,
        timeout: { tools: { searchKnowledgeMs: SEARCH_TIMEOUT_MS } },
        experimental_transform: replyFilter(),
      });
      return quotaStream(
        toUIMessageStream({
          stream: result.stream,
          tools: agent.tools,
          originalMessages: messages,
          onError: (error) => {
            this.logger.error(
              `Blog assistant stream failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return chatErrorCode(error);
          },
        }),
        this.usage,
        ticket,
      );
    } catch (error) {
      await this.refund(ticket);
      throw error;
    }
  }

  private async linkedRecipes(
    userId: string,
    blogId: string,
  ): Promise<LinkedRecipe[]> {
    const post = await this.posts
      .findOne({ _id: blogId, authorId: userId, type: PostType.BLOG })
      .select('blog.recipeIds')
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
    const recipeIds = post.blog?.recipeIds ?? [];
    if (recipeIds.length === 0) return [];
    const recipes = await this.recipes.find({ _id: { $in: recipeIds } }).exec();
    const ingredients = await this.ingredients
      .find({
        _id: {
          $in: [
            ...new Set(
              recipes.flatMap((recipe) =>
                recipe.ingredients.map(({ ingredientId }) => ingredientId),
              ),
            ),
          ],
        },
      })
      .exec();
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const ingredientById = new Map(
      ingredients.map((ingredient) => [ingredient.id, ingredient]),
    );
    return recipeIds.flatMap((recipeId) => {
      const recipe = recipeById.get(recipeId);
      if (!recipe) return [];
      return [
        {
          title: recipe.title,
          servings: recipe.servings,
          prepMinutes: recipe.prepMinutes,
          cookMinutes: recipe.cookMinutes,
          ingredients: recipe.ingredients.flatMap(
            ({ quantity, unit, ingredientId }) => {
              const ingredient = ingredientById.get(ingredientId);
              return ingredient
                ? [
                    {
                      name: ingredient.name,
                      quantity: quantity?.toString() ?? null,
                      unit,
                    },
                  ]
                : [];
            },
          ),
        },
      ];
    });
  }

  private async refund(ticket: UsageTicket): Promise<void> {
    await this.usage
      .refund(ticket)
      .catch((error: unknown) =>
        this.logger.warn(`Quota refund failed: ${String(error)}`),
      );
  }
}

export async function parseMessages(
  raw: unknown[],
  tools: BlogAssistantTools,
): Promise<UIMessage[]> {
  const result = await safeValidateUIMessages({ messages: raw, tools });
  if (!result.success) invalidMessages(result.error.message);
  const messages = result.data;
  const last = messages[messages.length - 1];
  if (last.role === 'user') {
    const text = textOf(last);
    if (!text.trim()) invalidMessages('The last message has no text');
    if (text.length > MAX_SELECTION)
      invalidMessages(`Messages are limited to ${MAX_SELECTION} characters`);
  } else if (last.role === 'assistant') {
    const toolParts = last.parts.filter(isToolUIPart);
    if (
      !toolParts.length ||
      toolParts.some(
        ({ state }) => state !== 'output-available' && state !== 'output-error',
      )
    )
      invalidMessages('The assistant message is waiting for tool outputs');
  } else {
    invalidMessages('The last message must come from the user');
  }
  return messages;
}

function invalidMessages(message: string): never {
  throw new InvalidInputException('BLOG_AI_INVALID_MESSAGES', message);
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map(({ text }) => text)
    .join('\n');
}
