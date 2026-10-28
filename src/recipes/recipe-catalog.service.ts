import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { escapeRegExp } from '../common/text.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { Ingredient, Recipe, RecipeFavorite } from '../mongo/models.js';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
  totalMinutes,
} from './dto/recipe-catalog.dto.js';
import { toRecipeCard } from './dto/recipe.dto.js';
import { DietaryService } from './dietary.service.js';
import { IncompatibilityRulesService } from './incompatibility-rules.service.js';
import {
  RecipeRelationsService,
  sourcePostIds,
} from './recipe-relations.service.js';

@Injectable()
export class RecipeCatalogService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(RecipeFavorite.name)
    private readonly favorites: Model<RecipeFavorite>,
    private readonly relations: RecipeRelationsService,
    private readonly rules: IncompatibilityRulesService,
    private readonly dietary: DietaryService,
  ) {}

  async list(
    query: RecipeCatalogQueryDto,
    userId?: string,
  ): Promise<PaginatedResponseDto<CatalogRecipeDto>> {
    if (query.suitableForMe && !userId) {
      throw new UnauthorizedException(
        'Sign in to filter by your dietary profile',
      );
    }
    const { rows, total } = await this.catalogPage(
      query,
      getPaginationArgs(query),
      userId,
    );
    const [recipes, favoriteIds, publishedPosts] = await Promise.all([
      this.relations.hydrate(rows),
      this.favoriteIds(
        rows.map(({ id }) => id),
        userId,
      ),
      this.relations.publishedPostIds(sourcePostIds(rows)),
    ]);
    return createPaginatedResponse(
      rows.map((row, index) => ({
        ...toRecipeCard(recipes[index]),
        isFavorite: favoriteIds.has(row.id),
        // Admin-authored recipes are public, but their source post may not be.
        post:
          row.postId && publishedPosts.has(row.postId)
            ? recipes[index].post
            : null,
        totalMinutes: totalMinutes(row),
      })),
      total,
      query,
    );
  }

  async findOne(id: string, userId?: string): Promise<CatalogRecipeDetailDto> {
    const row = await this.recipes.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Recipe not found');
    const [[detail], favoriteIds, publishedPosts] = await Promise.all([
      this.relations.hydrate([row]),
      this.favoriteIds([id], userId),
      this.relations.publishedPostIds(sourcePostIds([row])),
    ]);
    return {
      ...detail,
      isFavorite: favoriteIds.has(id),
      post: row.postId && publishedPosts.has(row.postId) ? detail.post : null,
      totalMinutes: totalMinutes(row),
    };
  }

  /**
   * The recipes of one catalog page, newest first, and how many match in all.
   */
  private async catalogPage(
    query: RecipeCatalogQueryDto,
    paging: { skip: number; take: number },
    userId?: string,
  ): Promise<{ rows: Recipe[]; total: number }> {
    let matching = await this.recipes
      .find()
      .select(
        'title description imageUrl servings prepMinutes cookMinutes ingredients steps postId updatedAt',
      )
      .sort({ updatedAt: -1, _id: -1 })
      .exec();

    if (query.q !== undefined) {
      const matchingIds = await this.matchingRecipeIds(query.q);
      matching = matching.filter(({ id }) => matchingIds.has(id));
    }
    if (query.maxMinutes !== undefined) {
      const max = query.maxMinutes;
      // A recipe with both times unknown never matches.
      matching = matching.filter((row) => {
        const minutes = totalMinutes(row);
        return minutes !== null && minutes <= max;
      });
    }
    if (query.suitableForMe && userId) {
      const avoided = await this.dietary.avoidedIngredientIds(userId);
      matching = matching.filter(({ ingredients }) =>
        ingredients.every(({ ingredientId }) => !avoided.has(ingredientId)),
      );
      const conflicts = await this.rules.findConflictsForEach(
        matching.map(({ ingredients }) =>
          ingredients.map(({ ingredientId }) => ingredientId),
        ),
      );
      matching = matching.filter((_, index) => conflicts[index].length === 0);
    }
    return {
      rows: matching.slice(paging.skip, paging.skip + paging.take),
      total: matching.length,
    };
  }

  /** Title, description, or an ingredient whose name or alias contains `text`. */
  private async matchingRecipeIds(text: string): Promise<Set<string>> {
    const pattern = escapeRegExp(text);
    const matchingIngredients = await this.ingredients
      .find({
        $or: [
          { name: { $regex: pattern, $options: 'i' } },
          { aliases: { $regex: pattern, $options: 'i' } },
        ],
      })
      .select('_id')
      .exec();
    const rows = await this.recipes
      .find({
        $or: [
          { title: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
          {
            'ingredients.ingredientId': {
              $in: matchingIngredients.map(({ id }) => id),
            },
          },
        ],
      })
      .select('_id')
      .exec();
    return new Set(rows.map(({ id }) => id));
  }

  private async favoriteIds(
    recipeIds: string[],
    userId?: string,
  ): Promise<Set<string>> {
    if (!userId) return new Set();
    const favorites = await this.favorites
      .find({ userId, recipeId: { $in: recipeIds } })
      .select('recipeId')
      .exec();
    return new Set(favorites.map(({ recipeId }) => recipeId));
  }
}
