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
} from '../common/pagination';
import { lockDocument } from '../mongo/document-lock';
import { Recipe, RecipeFavorite, Stored, User } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { totalMinutes } from './dto/recipe-catalog.dto';
import {
  FavoriteRecipeDto,
  RecipeFavoriteStateDto,
} from './dto/recipe-favorite.dto';
import { toRecipeCard } from './dto/recipe.dto';
import { RecipeRelationsService } from './recipe-relations.service';

@Injectable()
export class RecipeFavoritesService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeFavorite.name)
    private readonly favorites: Model<RecipeFavorite>,
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
      this.relations.publishedPostIds(ordered.map(({ postId }) => postId)),
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
    const { db } = this.mongo;
    return this.mongo.withTransaction(async (session) => {
      await lockDocument(db, session, 'user', userId);
      await lockDocument(db, session, 'recipe', recipeId);
      // One session runs one operation at a time.
      const user = await db
        .collection<Stored<User>>('users')
        .findOne({ _id: userId }, { session });
      const recipe = await db
        .collection<Stored<Recipe>>('recipes')
        .findOne({ _id: recipeId }, { session });
      if (!user) throw new UnauthorizedException('Account no longer exists');
      if (!recipe) throw new NotFoundException('Recipe not found');
      const favorites =
        db.collection<Stored<RecipeFavorite>>('recipe_favorites');
      if (isFavorite) {
        // Duplicate retries preserve the original savedAt and ordering.
        await favorites.updateOne(
          { recipeId, userId },
          { $setOnInsert: { _id: randomUUID(), createdAt: new Date() } },
          { upsert: true, session },
        );
      } else {
        await favorites.deleteOne({ recipeId, userId }, { session });
      }
      return { recipeId, isFavorite };
    });
  }
}
