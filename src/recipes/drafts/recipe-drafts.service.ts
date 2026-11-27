import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { aiFailure } from '../../ai/provider-failure.js';
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
  type DraftRequest,
  toRecipeDraft,
} from './recipe-draft.js';
import {
  type DraftResult,
  RecipeDraftGenerator,
} from './recipe-draft.generator.js';

const MAX_CATALOG_INGREDIENTS =
  runtimeConfig.RECIPE_DRAFT_MAX_CATALOG_INGREDIENTS;

/** Reads a post, pasted caption or the form's recipe with AI and returns a recipe form prefill. */
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
    const request: DraftRequest = {
      parts: source.parts,
      currentRecipe: dto.currentRecipe || null,
      instruction: dto.instruction || null,
    };
    if (request.parts.length === 0 && !request.currentRecipe) {
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
    if (ingredients.length >= MAX_CATALOG_INGREDIENTS) {
      this.logger.warn(
        `The catalog has at least ${MAX_CATALOG_INGREDIENTS} ingredients; the draft only sees the first ${MAX_CATALOG_INGREDIENTS} by name, so later ones never match. Raise RECIPE_DRAFT_MAX_CATALOG_INGREDIENTS or look ingredients up per name.`,
      );
    }
    const catalog = buildDraftCatalog(
      ingredients.map((row) => ({
        id: row.id,
        name: row.name,
        aliases: [...row.aliases],
      })),
      groups.map((row) => ({ id: row.id, name: row.name })),
    );

    const startedAt = Date.now();
    const result = await this.generate(adminId, request, catalog);
    const recipe = toRecipeDraft(result.output, catalog);
    const calorieResearch = recipe ? result.calorieResearch : 'SKIPPED';
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `Recipe draft in ${seconds}s by ${this.generator.modelId} (${source.description}): ${describeDraft(recipe)}, calories ${calorieResearch}`,
    );
    return {
      recipe,
      untranscribedVideos: source.untranscribedVideos,
      calorieResearch,
    };
  }

  private async generate(
    adminId: string,
    request: DraftRequest,
    catalog: DraftCatalog,
  ): Promise<DraftResult> {
    const executionId = randomUUID();
    const context = {
      feature: 'RECIPE_DRAFT',
      userId: adminId,
      executionId,
      turnId: executionId,
    };
    try {
      return await aiCostContext.run(context, () =>
        this.generator.generate(request, catalog),
      );
    } catch (error: unknown) {
      throw aiFailure('Recipe draft', error);
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
    const currentRecipe = dto.currentRecipe ?? '';
    let sourceCount = 0;
    for (const given of [dto.postId, text, currentRecipe]) {
      if (given) sourceCount += 1;
    }
    if (sourceCount !== 1) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Send exactly one of postId, text or currentRecipe',
      );
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
    if (currentRecipe) {
      // The form's recipe is not a source part: it goes in its own prompt tag.
      return {
        parts: [],
        description: `form recipe ${currentRecipe.length} chars`,
        untranscribedVideos: 0,
      };
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
