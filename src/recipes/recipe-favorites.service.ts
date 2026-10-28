import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { lockDocument } from '../mongo/document-lock.js';
import { Recipe, RecipeFavorite, User } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { totalMinutes } from './dto/recipe-catalog.dto.js';
import {
  FavoriteRecipeDto,
  RecipeFavoriteStateDto,
} from './dto/recipe-favorite.dto.js';
import { toRecipeCard } from './dto/recipe.dto.js';
import {
  RecipeRelationsService,
  sourcePostIds,
} from './recipe-relations.service.js';

@Injectable()
export class RecipeFavoritesService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeFavorite.name)
    private readonly favorites: Model<RecipeFavorite>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly relations: RecipeRelationsService,
    private readonly mongo: MongoService,
  ) {}

  async list(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<FavoriteRecipeDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, count] = await Promise.all([
      this.favorites
        .find({ userId })
        .sort({ createdAt: -1, recipeId: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.favorites.countDocuments({ userId }),
    ]);
    const recipeIds = rows.map(({ recipeId }) => recipeId);
    const saved = await this.recipes.find({ _id: { $in: recipeIds } }).exec();
    const savedById = new Map(saved.map((recipe) => [recipe.id, recipe]));
    const ordered = rows.flatMap(
      ({ recipeId }) => savedById.get(recipeId) ?? [],
    );
    const [recipes, published] = await Promise.all([
      this.relations.hydrate(ordered),
      this.relations.publishedPostIds(sourcePostIds(ordered)),
    ]);
    return createPaginatedResponse(
      ordered.map((recipe, index) => ({
        ...toRecipeCard(recipes[index]),
        post:
          recipe.postId && published.has(recipe.postId)
            ? recipes[index].post
            : null,
        totalMinutes: totalMinutes(recipe),
        isFavorite: true,
        savedAt: rows[index].createdAt,
      })),
      count,
      query,
    );
  }

  async set(
    recipeId: string,
    userId: string,
    isFavorite: boolean,
  ): Promise<RecipeFavoriteStateDto> {
    return this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', userId);
      await lockDocument(this.mongo, session, 'recipe', recipeId);
      // One session runs one operation at a time.
      const user = await this.users
        .findOne({ _id: userId })
        .session(session)
        .exec();
      const recipe = await this.recipes
        .findOne({ _id: recipeId })
        .session(session)
        .exec();
      if (!user) throw new UnauthorizedException('Account no longer exists');
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (isFavorite) {
        // Duplicate retries preserve the original savedAt and ordering.
        await this.favorites
          .updateOne(
            { recipeId, userId },
            { $setOnInsert: { _id: randomUUID(), createdAt: new Date() } },
            { upsert: true, session },
          )
          .exec();
      } else {
        await this.favorites
          .deleteOne({ recipeId, userId }, { session })
          .exec();
      }
      return { recipeId, isFavorite };
    });
  }
}
