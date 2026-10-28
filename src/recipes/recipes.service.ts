import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { Recipe } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  RecipeDetailDto,
  RecipeDto,
  SaveRecipeDto,
  toRecipeCard,
} from './dto/recipe.dto.js';
import { RecipeRelationsService } from './recipe-relations.service.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';

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
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'Recipe not found');
    const [recipe] = await this.relations.hydrate([row]);
    return recipe;
  }

  async create(userId: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    await this.relations.assertReferences(dto.ingredients, dto.postId);
    const recipe = await this.recipes.create({
      _id: randomUUID(),
      ...toData(dto),
      createdById: userId,
    });
    return this.findOne(recipe.id);
  }

  async update(id: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    await this.relations.assertReferences(dto.ingredients, dto.postId);
    const updated = await this.recipes
      .updateOne({ _id: id }, { $set: toData(dto) })
      .exec();
    if (updated.matchedCount === 0) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Recipe not found');
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const { deletedCount } = await this.mongo.withTransaction((session) =>
      this.recipes.deleteOne({ _id: id }, { session }).exec(),
    );
    if (deletedCount === 0)
      throw new ResourceNotFoundException('NOT_FOUND', 'Recipe not found');
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
    ingredients: dto.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      quantity: item.quantity ?? null,
      unit: item.unit || null,
      note: item.note || null,
    })),
    steps: dto.steps,
    postId: dto.postId ?? null,
  };
}
