import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Ingredient, Post, PostStatus, Recipe, User } from '../mongo/models.js';
import { allExist } from '../mongo/references.js';
import { RecipeDetailDto } from './dto/recipe.dto.js';
import { IncompatibilityRulesService } from './incompatibility-rules.service.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

/**
 * Reads the collections a recipe card joins: its ingredient names, the source
 * post and its author, and the conflicts between the ingredients. It owns
 * those collections, so the services that render recipes depend on one
 * collaborator instead of four models.
 */
@Injectable()
export class RecipeRelationsService {
  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly rules: IncompatibilityRulesService,
  ) {}

  /** Recipe details for `rows`, in the same order. */
  async hydrate(rows: readonly Recipe[]): Promise<RecipeDetailDto[]> {
    const postIds = rows.flatMap(({ postId }) => (postId ? [postId] : []));
    const ingredientIds = [
      ...new Set(
        rows.flatMap(({ ingredients }) =>
          ingredients.map(({ ingredientId }) => ingredientId),
        ),
      ),
    ];
    const [ingredients, posts] = await Promise.all([
      this.ingredients.find({ _id: { $in: ingredientIds } }).exec(),
      this.posts.find({ _id: { $in: postIds } }).exec(),
    ]);
    const authorIds = [...new Set(posts.map(({ authorId }) => authorId))];
    const authors = await this.users.find({ _id: { $in: authorIds } }).exec();
    const ingredientById = new Map(
      ingredients.map((ingredient) => [ingredient.id, ingredient]),
    );
    const authorById = new Map(authors.map((author) => [author.id, author]));
    const postById = new Map(posts.map((post) => [post.id, post]));
    const conflicts = await this.rules.findConflictsForEach(
      rows.map(({ ingredients }) =>
        ingredients.map((item) => item.ingredientId),
      ),
    );
    return rows.map((row, index) => {
      const rowItems = row.ingredients;
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

  /** The source posts among `postIds` that are published. */
  async publishedPostIds(postIds: readonly string[]): Promise<Set<string>> {
    const posts = await this.posts
      .find({
        status: PostStatus.PUBLISHED,
        _id: { $in: postIds },
      })
      .select('_id')
      .exec();
    return new Set(posts.map(({ id }) => id));
  }

  /** The ingredients and the source post must exist: there are no foreign keys. */
  async assertReferences(
    ingredients: readonly { ingredientId: string }[],
    postId?: string,
  ): Promise<void> {
    const ingredientIds = ingredients.map(({ ingredientId }) => ingredientId);
    // An omitted postId means "no source post", which needs no existence check.
    const postIds = postId === undefined ? [] : [postId];
    const [found, post] = await Promise.all([
      allExist(this.ingredients, ingredientIds),
      allExist(this.posts, postIds),
    ]);
    if (!found || !post) {
      throw new InvalidInputException(
        'UNKNOWN_REFERENCE',
        'An ingredient or the post in the request does not exist',
      );
    }
  }
}

/** The source post ids of recipes; recipes without a source post are skipped. */
export function sourcePostIds(
  recipes: readonly { postId?: string | null }[],
): string[] {
  const postIds: string[] = [];
  for (const { postId } of recipes) {
    if (postId) postIds.push(postId);
  }
  return postIds;
}
