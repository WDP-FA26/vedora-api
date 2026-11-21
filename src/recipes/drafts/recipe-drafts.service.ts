import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { openRouterFailure } from '../../ai/openrouter-client.js';
import { aiCostContext } from '../../ai/telemetry/ai-cost-context.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import {
  Ingredient,
  IngredientGroup,
  MediaAsset,
  MediaStatus,
  Post,
} from '../../mongo/models.js';
import {
  clipParts,
  readPostSource,
  type PostSource,
} from '../../posts/summaries/post-source.js';
import type {
  CreateRecipeDraftDto,
  RecipeDraftDto,
} from '../dto/recipe-draft.dto.js';
import {
  buildDraftCatalog,
  type DraftCatalog,
  type DraftOutput,
  toRecipeDraft,
} from './recipe-draft.js';
import { RecipeDraftGenerator } from './recipe-draft.generator.js';

const MAX_CATALOG_INGREDIENTS =
  runtimeConfig.RECIPE_DRAFT_MAX_CATALOG_INGREDIENTS;

/** Reads a post or pasted caption with AI and returns a recipe form prefill. */
@Injectable()
export class RecipeDraftsService {
  private readonly logger = new Logger(RecipeDraftsService.name);

  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    private readonly generator: RecipeDraftGenerator,
  ) {}

  async create(
    adminId: string,
    dto: CreateRecipeDraftDto,
  ): Promise<RecipeDraftDto> {
    const source = await this.sourceOf(dto);
    if (source.parts.length === 0) {
      throw new InvalidInputException(
        'EMPTY_RECIPE_SOURCE',
        'There is no text to read a recipe from',
        { untranscribedVideos: source.untranscribedVideos },
      );
    }
    const [ingredients, groups] = await Promise.all([
      this.ingredients
        .find()
        .sort({ name: 1, _id: 1 })
        .limit(MAX_CATALOG_INGREDIENTS)
        .select('name aliases')
        .exec(),
      this.groups.find().sort({ name: 1, _id: 1 }).select('name').exec(),
    ]);
    const catalog = buildDraftCatalog(
      ingredients.map((row) => ({
        id: row.id,
        name: row.name,
        aliases: [...row.aliases],
      })),
      groups.map((row) => ({ id: row.id, name: row.name })),
    );

    const startedAt = Date.now();
    const output = await this.generate(adminId, source, catalog);
    const recipe = toRecipeDraft(output, catalog);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `Recipe draft in ${seconds}s by ${this.generator.modelId} (${source.description}): ${describeDraft(recipe)}`,
    );
    return { recipe, untranscribedVideos: source.untranscribedVideos };
  }

  private async generate(
    adminId: string,
    source: PostSource,
    catalog: DraftCatalog,
  ): Promise<DraftOutput> {
    const executionId = randomUUID();
    const context = {
      feature: 'RECIPE_DRAFT',
      userId: adminId,
      executionId,
      turnId: executionId,
    };
    try {
      return await aiCostContext.run(context, () =>
        this.generator.generate(source.parts, catalog),
      );
    } catch (error: unknown) {
      throw openRouterFailure('Recipe draft', error);
    }
  }

  private async requireReadyVideo(
    postId: string,
    mediaId: string,
  ): Promise<void> {
    const found = await this.mediaAssets.exists({
      _id: mediaId,
      postId,
      status: MediaStatus.READY,
      discardedAt: null,
    });
    if (!found) {
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'The post has no such ready video',
      );
    }
  }

  private async sourceOf(dto: CreateRecipeDraftDto): Promise<PostSource> {
    const text = dto.text ?? '';
    if (dto.postId && text) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Send either postId or text, not both',
      );
    }
    if (!dto.postId && !text) {
      throw new InvalidInputException('BAD_REQUEST', 'Send postId or text');
    }
    if (dto.mediaId && !dto.postId) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'mediaId needs the postId of its post',
      );
    }
    if (dto.postId) {
      const post = await this.posts.findById(dto.postId).exec();
      if (!post) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (dto.mediaId) await this.requireReadyVideo(post.id, dto.mediaId);
      return readPostSource(post, this.mediaAssets, dto.mediaId);
    }
    return {
      parts: clipParts([{ label: 'Pasted caption', text }]),
      description: `pasted text ${text.length} chars`,
      untranscribedVideos: 0,
    };
  }
}

function describeDraft(recipe: ReturnType<typeof toRecipeDraft>): string {
  if (!recipe) return 'no recipe';
  let matched = 0;
  for (const ingredient of recipe.ingredients) {
    if (ingredient.match) matched += 1;
  }
  return `"${recipe.title}", ${matched}/${recipe.ingredients.length} ingredients in the catalog, ${recipe.steps.length} steps`;
}
