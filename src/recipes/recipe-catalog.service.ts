import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import {
  Ingredient,
  Post,
  PostStatus,
  Recipe,
  RecipeFavorite,
  RecipeIngredient,
  User,
} from '../mongo/models';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
} from './dto/recipe-catalog.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { DietaryService } from './dietary.service';
import { catalogPage } from './recipe-catalog.query';
import { loadRecipes, toRecipeDto } from './recipes.service';

@Injectable()
export class RecipeCatalogService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeIngredient.name)
    private readonly recipeIngredients: Model<RecipeIngredient>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(RecipeFavorite.name)
    private readonly favorites: Model<RecipeFavorite>,
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
    const { ids, total } = await catalogPage(
      {
        recipes: this.recipes,
        recipeIngredients: this.recipeIngredients,
        ingredients: this.ingredients,
        dietary: this.dietary,
        rules: this.rules,
      },
      query,
      getPaginationArgs(query),
      userId,
    );
    const rows = await this.recipes.find({ _id: { $in: ids } }).exec();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.flatMap((id) => byId.get(id) ?? []);
    const [recipes, favoriteIds, publishedPosts] = await Promise.all([
      loadRecipes(
        {
          recipeIngredients: this.recipeIngredients,
          ingredients: this.ingredients,
          posts: this.posts,
          users: this.users,
        },
        this.rules,
        ordered,
      ),
      this.favoriteIds(ids, userId),
      this.publishedPosts(ordered.map(({ postId }) => postId)),
    ]);
    return createPaginatedResponse(
      ordered.map((row, index) => ({
        ...toRecipeDto(recipes[index]),
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
      loadRecipes(
        {
          recipeIngredients: this.recipeIngredients,
          ingredients: this.ingredients,
          posts: this.posts,
          users: this.users,
        },
        this.rules,
        [row],
      ),
      this.favoriteIds([id], userId),
      this.publishedPosts([row.postId]),
    ]);
    return {
      ...detail,
      isFavorite: favoriteIds.has(id),
      post: row.postId && publishedPosts.has(row.postId) ? detail.post : null,
      totalMinutes: totalMinutes(row),
    };
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

  private async publishedPosts(
    postIds: (string | null)[],
  ): Promise<Set<string>> {
    const posts = await this.posts
      .find({
        status: PostStatus.PUBLISHED,
        _id: { $in: postIds.filter((id) => id !== null) },
      })
      .select('_id')
      .exec();
    return new Set(posts.map(({ id }) => id));
  }
}

export function totalMinutes(recipe: {
  prepMinutes: number | null;
  cookMinutes: number | null;
}): number | null {
  return recipe.prepMinutes === null && recipe.cookMinutes === null
    ? null
    : (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
}
