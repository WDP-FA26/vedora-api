import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  convertToModelMessages,
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
import { moderateWithRetry } from '../../../ai/moderation/moderation.js';
import {
  chatModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MODERATION_MODEL,
} from '../../../ai/openrouter.js';
import { AiUsageService } from '../../../ai/usage/ai-usage.service.js';
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
import {
  BLOG_ASSISTANT_POLICY,
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

// room to search, generate an image and propose a couple of edits
const MAX_STEPS = 8;
const MAX_OUTPUT_TOKENS = 4000;
const SEARCH_TIMEOUT_MS = 5000;

/**
 * The writing assistant beside the blog editor. It edits the draft through
 * editor tools that run in the browser (the user accepts or rejects each
 * change), grounds nutrition facts in the knowledge base and the blog's
 * recipes, and generates illustrations. Every request, including the one
 * that resumes after the browser answers an editor tool, counts against the
 * daily `BLOG_CHAT` allowance: the history comes from the client, so a resume
 * cannot be told apart from a new turn.
 */
@Injectable()
export class BlogAssistantService {
  private readonly logger = new Logger(BlogAssistantService.name);
  private readonly model: LanguageModel;
  private readonly moderationModel: LanguageModel;

  constructor(
    configService: ConfigService,
    private readonly knowledge: KnowledgeSearchService,
    private readonly images: BlogImageGeneratorService,
    private readonly usage: AiUsageService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
  ) {
    const apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.moderationModel = chatModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        DEFAULT_MODERATION_MODEL,
      ),
      reasoningEffort: 'low',
    });
    // `openrouter/auto` may route to a model that calls tools poorly; pin one
    // for this agent with BLOG_AI_MODEL
    this.model = chatModel({
      apiKey,
      modelId:
        configService.get<string>('BLOG_AI_MODEL') ||
        configService.get<string>('OPENROUTER_MODEL', DEFAULT_CHAT_MODEL),
      reasoningEffort: configService.get('OPENROUTER_REASONING_EFFORT', 'low'),
    });
  }

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
    const tools = blogAssistantTools(userId, this.knowledge, this.images);
    const messages = await parseMessages(dto.messages, tools);
    const last = messages[messages.length - 1];
    const recipes = dto.blogId
      ? await this.linkedRecipes(userId, dto.blogId)
      : [];

    if (!(await this.usage.consume(userId, AiFeature.BLOG_CHAT))) {
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'You have used all assistant requests for today',
      );
    }

    // a resumed turn only carries editor tool outputs, checked by schema
    if (last.role === 'user') {
      const verdict = await moderateWithRetry(
        this.moderationModel,
        textOf(last),
        abortSignal,
        BLOG_ASSISTANT_POLICY,
      ).catch(async (error: unknown) => {
        await this.refund(userId);
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
        await this.refund(userId);
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
    return toUIMessageStream({
      stream: result.stream,
      tools: agent.tools,
      // resuming after an editor tool continues the same assistant message
      originalMessages: messages,
      onError: (error) => {
        this.logger.error(
          `Blog assistant stream failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return chatErrorCode(error);
      },
    });
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

  private async refund(userId: string): Promise<void> {
    await this.usage
      .refund(userId, AiFeature.BLOG_CHAT)
      .catch((error: unknown) =>
        this.logger.warn(`Quota refund failed: ${String(error)}`),
      );
  }
}

/**
 * Checks the client's history against the tools' schemas, then that it ends
 * with either a user message or an assistant message whose tool calls all
 * have outputs (the browser resuming the turn after an editor tool).
 */
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
