import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { escapeRegExp } from '../common/text';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import {
  Ingredient,
  Recipe,
  RecipeFavorite,
  RecipeIngredient,
} from '../mongo/models';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
  totalMinutes,
} from './dto/recipe-catalog.dto';
import { toRecipeCard } from './dto/recipe.dto';
import { DietaryService } from './dietary.service';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { RecipeRelationsService } from './recipe-relations.service';

@Injectable()
export class RecipeCatalogService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeIngredient.name)
    private readonly recipeIngredients: Model<RecipeIngredient>,
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
      this.relations.publishedPostIds(rows.map(({ postId }) => postId)),
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
      this.relations.publishedPostIds([row.postId]),
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
   * MongoDB has no relation filters, and total minutes and conflicts inside a
   * recipe are no filter at all, so this reads the ids, times and ingredients
   * of every recipe the title/description filter leaves and filters them
   * here. The catalog is admin-curated and small.
   */
  private async catalogPage(
    query: RecipeCatalogQueryDto,
    paging: { skip: number; take: number },
    userId?: string,
  ): Promise<{ rows: Recipe[]; total: number }> {
    const [rows, links] = await Promise.all([
      this.recipes
        .find()
        // Everything a card and a detail need, so the page renders without
        // a second read of the recipes it picked.
        .select(
          'title description imageUrl servings prepMinutes cookMinutes steps postId updatedAt',
        )
        .sort({ updatedAt: -1, _id: -1 })
        .exec(),
      this.recipeIngredients.find().select('recipeId ingredientId').exec(),
    ]);
    const ingredientsOf = (recipeId: string) =>
      links
        .filter((link) => link.recipeId === recipeId)
        .map(({ ingredientId }) => ingredientId);

    let matching = rows;
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
      matching = matching.filter(({ id }) =>
        ingredientsOf(id).every((ingredientId) => !avoided.has(ingredientId)),
      );
      const conflicts = await this.rules.findConflictsForEach(
        matching.map(({ id }) => ingredientsOf(id)),
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
    const [byText, matchingIngredients] = await Promise.all([
      this.recipes
        .find({
          $or: [
            { title: { $regex: pattern, $options: 'i' } },
            { description: { $regex: pattern, $options: 'i' } },
          ],
        })
        .select('_id')
        .exec(),
      this.ingredients
        .find({
          $or: [
            { name: { $regex: pattern, $options: 'i' } },
            { aliases: { $regex: pattern, $options: 'i' } },
          ],
        })
        .select('_id')
        .exec(),
    ]);
    const byIngredient = await this.recipeIngredients
      .find({
        ingredientId: { $in: matchingIngredients.map(({ id }) => id) },
      })
      .select('recipeId')
      .exec();
    return new Set([
      ...byText.map(({ id }) => id),
      ...byIngredient.map(({ recipeId }) => recipeId),
    ]);
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
