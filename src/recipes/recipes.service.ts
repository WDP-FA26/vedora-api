import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import { Recipe, RecipeIngredient, Stored } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { deleteWithReferences } from '../mongo/relations';
import {
  RecipeDetailDto,
  RecipeDto,
  SaveRecipeDto,
  toRecipeCard,
} from './dto/recipe.dto';
import { RecipeRelationsService } from './recipe-relations.service';

@Injectable()
export class RecipesService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    private readonly relations: RecipeRelationsService,
    private readonly mongo: MongoService,
  ) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, totalItems] = await Promise.all([
      this.recipes
        .find()
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.recipes.countDocuments(),
    ]);
    const recipes = await this.relations.hydrate(rows);
    return createPaginatedResponse(
      recipes.map(toRecipeCard),
      totalItems,
      query,
    );
  }

  async findOne(id: string): Promise<RecipeDetailDto> {
    const row = await this.recipes.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Recipe not found');
    const [recipe] = await this.relations.hydrate([row]);
    return recipe;
  }

  async create(userId: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    await this.relations.assertReferences(dto.ingredients, dto.postId);
    const id = randomUUID();
    await this.mongo.withTransaction(async (session) => {
      const now = new Date();
      await this.mongo.db.collection<Stored<Recipe>>('recipes').insertOne(
        {
          _id: id,
          ...toData(dto),
          createdById: userId,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.addIngredients(session, id, dto);
    });
    return this.findOne(id);
  }

  async update(id: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    await this.relations.assertReferences(dto.ingredients, dto.postId);
    await this.mongo.withTransaction(async (session) => {
      const updated = await this.mongo.db
        .collection<Stored<Recipe>>('recipes')
        .updateOne(
          { _id: id },
          { $set: { ...toData(dto), updatedAt: new Date() } },
          { session },
        );
      if (updated.matchedCount === 0) {
        throw new NotFoundException('Recipe not found');
      }
      await this.mongo.db
        .collection<Stored<RecipeIngredient>>('recipe_ingredients')
        .deleteMany({ recipeId: id }, { session });
      await this.addIngredients(session, id, dto);
    });
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.mongo.withTransaction((session) =>
      deleteWithReferences(this.mongo.db, session, 'recipes', {
        _id: id,
      }),
    );
    if (deleted === 0) throw new NotFoundException('Recipe not found');
  }

  private async addIngredients(
    session: ClientSession,
    recipeId: string,
    dto: SaveRecipeDto,
  ): Promise<void> {
    await this.mongo.db
      .collection<Stored<RecipeIngredient>>('recipe_ingredients')
      .insertMany(
        dto.ingredients.map((item, position) => ({
          _id: randomUUID(),
          recipeId,
          ingredientId: item.ingredientId,
          position,
          quantity: item.quantity ?? null,
          unit: item.unit || null,
          note: item.note || null,
        })),
        { session },
      );
  }
}

function toData(dto: SaveRecipeDto) {
  return {
    title: dto.title,
    description: dto.description || null,
    imageUrl: dto.imageUrl || null,
    servings: dto.servings,
    prepMinutes: dto.prepMinutes ?? null,
    cookMinutes: dto.cookMinutes ?? null,
    steps: dto.steps,
    postId: dto.postId ?? null,
  };
}
