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
import {
  Ingredient,
  Post,
  Recipe,
  RecipeIngredient,
  Stored,
  User,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { allExist } from '../mongo/references';
import { deleteWithReferences } from '../mongo/relations';
import { RecipeDetailDto, RecipeDto, SaveRecipeDto } from './dto/recipe.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { badRequest } from './recipe-errors';

/** The models `loadRecipes` joins. */
export interface RecipeLoadDeps {
  recipeIngredients: Model<RecipeIngredient>;
  ingredients: Model<Ingredient>;
  posts: Model<Post>;
  users: Model<User>;
}

/**
 * Recipe cards for `rows`, in the same order: ingredients with their names
 * (by position), the source post and its author, and ingredient conflicts.
 */
export async function loadRecipes(
  deps: RecipeLoadDeps,
  rules: IncompatibilityRulesService,
  rows: readonly Recipe[],
): Promise<RecipeDetailDto[]> {
  const recipeIds = rows.map(({ id }) => id);
  const postIds = rows.flatMap(({ postId }) => (postId ? [postId] : []));
  const [items, posts] = await Promise.all([
    deps.recipeIngredients
      .find({ recipeId: { $in: recipeIds } })
      .sort({ position: 1 })
      .exec(),
    deps.posts.find({ _id: { $in: postIds } }).exec(),
  ]);
  const ingredientIds = [
    ...new Set(items.map(({ ingredientId }) => ingredientId)),
  ];
  const authorIds = [...new Set(posts.map(({ authorId }) => authorId))];
  const [ingredients, authors] = await Promise.all([
    deps.ingredients.find({ _id: { $in: ingredientIds } }).exec(),
    deps.users.find({ _id: { $in: authorIds } }).exec(),
  ]);
  const ingredientById = new Map(
    ingredients.map((ingredient) => [ingredient.id, ingredient]),
  );
  const authorById = new Map(authors.map((author) => [author.id, author]));
  const ingredientsOf = (id: string) =>
    items.filter(({ recipeId }) => recipeId === id);
  const postById = new Map(posts.map((post) => [post.id, post]));
  const conflicts = await rules.findConflictsForEach(
    rows.map(({ id }) => ingredientsOf(id).map((item) => item.ingredientId)),
  );
  return rows.map((row, index) => {
    const rowItems = ingredientsOf(row.id);
    const names = new Map(
      rowItems.map((item) => [
        item.ingredientId,
        ingredientById.get(item.ingredientId)?.name ?? '',
      ]),
    );
    const named = (id: string) => ({ id, name: names.get(id) ?? '' });
    const post = row.postId ? postById.get(row.postId) : undefined;
    const author = post ? authorById.get(post.authorId) : undefined;
    return {
      id: row.id,
      title: row.title,
      imageUrl: row.imageUrl,
      servings: row.servings,
      prepMinutes: row.prepMinutes,
      cookMinutes: row.cookMinutes,
      ingredientCount: rowItems.length,
      conflictCount: conflicts[index].length,
      conflicts: conflicts[index].map(
        ({ ingredientAId, ingredientBId, ...rest }) => ({
          ...rest,
          a: named(ingredientAId),
          b: named(ingredientBId),
        }),
      ),
      post:
        post && author
          ? {
              id: post.id,
              author: {
                username: author.username,
                fullName: author.fullName,
              },
            }
          : null,
      updatedAt: row.updatedAt,
      description: row.description,
      steps: [...row.steps],
      ingredients: rowItems.map((item) => ({
        ingredientId: item.ingredientId,
        name: ingredientById.get(item.ingredientId)?.name ?? '',
        quantity: item.quantity,
        unit: item.unit,
        note: item.note,
      })),
    };
  });
}

/** The card fields only, for lists. */
export function toRecipeDto({
  description: _description,
  steps: _steps,
  ingredients: _ingredients,
  ...card
}: RecipeDetailDto): RecipeDto {
  return card;
}

@Injectable()
export class RecipesService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeIngredient.name)
    private readonly recipeIngredients: Model<RecipeIngredient>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly rules: IncompatibilityRulesService,
    private readonly mongo: MongoService,
  ) {}

  private get deps(): RecipeLoadDeps {
    return {
      recipeIngredients: this.recipeIngredients,
      ingredients: this.ingredients,
      posts: this.posts,
      users: this.users,
    };
  }

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
    const recipes = await loadRecipes(this.deps, this.rules, rows);
    return createPaginatedResponse(recipes.map(toRecipeDto), totalItems, query);
  }

  async findOne(id: string): Promise<RecipeDetailDto> {
    const row = await this.recipes.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Recipe not found');
    const [recipe] = await loadRecipes(this.deps, this.rules, [row]);
    return recipe;
  }

  async create(userId: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    await this.requireReferences(dto);
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
    await this.requireReferences(dto);
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
    if (dto.ingredients.length === 0) return;
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

  /** The ingredients and the source post must exist: there are no foreign keys. */
  private async requireReferences(dto: SaveRecipeDto): Promise<void> {
    const [ingredients, post] = await Promise.all([
      allExist(
        dto.ingredients.map((item) => item.ingredientId),
        (ids) => this.ingredients.countDocuments({ _id: { $in: ids } }),
      ),
      allExist([dto.postId], (ids) =>
        this.posts.countDocuments({ _id: { $in: ids } }),
      ),
    ]);
    if (!ingredients || !post) {
      throw badRequest(
        'UNKNOWN_REFERENCE',
        'An ingredient or the post in the request does not exist',
      );
    }
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
