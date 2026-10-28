import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import {
  AccountStatus,
  CaptionStatus,
  type Ingredient,
  type MediaAsset,
  MediaStatus,
  MediaType,
  type Post,
  PostStatus,
  PostType,
  type Recipe,
  type User,
  UserRole,
} from '../src/mongo/models.js';
import type { MongoService } from '../src/mongo/mongo.service.js';

// Documents with the defaults every write must spell out. Each takes the
// fields a test cares about and fills the rest.

function model<T>(db: MongoService, name: string): Model<T> {
  return db.connection.model<T>(name);
}

export function createUser(
  db: MongoService,
  fields: Partial<User> = {},
): Promise<User> {
  const { id, ...rest } = fields;
  const userId = id ?? randomUUID();
  return model<User>(db, 'User').create({
    _id: userId,
    username: `user.${userId.slice(0, 8)}`,
    fullName: 'Test User',
    email: `${userId}@example.test`,
    role: UserRole.USER,
    status: AccountStatus.ACTIVE,
    accountVersion: 0,
    isProfessional: false,
    emailVerifiedAt: new Date(),
    avoidedIngredientIds: [],
    avoidedGroupIds: [],
    likedIngredientIds: [],
    ...rest,
  });
}

export function createIngredient(
  db: MongoService,
  fields: Partial<Ingredient> = {},
): Promise<Ingredient> {
  const { id, ...rest } = fields;
  const ingredientId = id ?? randomUUID();
  return model<Ingredient>(db, 'Ingredient').create({
    _id: ingredientId,
    name: `ingredient ${ingredientId.slice(0, 8)}`,
    aliases: [],
    ...rest,
  });
}

/** A recipe with its embedded ingredients, in array order. */
export function createRecipe(
  db: MongoService,
  fields: Partial<Recipe> = {},
  ingredientIds: string[] = [],
): Promise<Recipe> {
  const { id, ingredients, ...rest } = fields;
  return model<Recipe>(db, 'Recipe').create({
    _id: id ?? randomUUID(),
    title: 'Test recipe',
    servings: 2,
    steps: ['Cook'],
    ingredients:
      ingredients ??
      ingredientIds.map((ingredientId) => ({
        ingredientId,
        quantity: null,
        unit: null,
        note: null,
      })),
    ...rest,
  });
}

export function createPost(
  db: MongoService,
  fields: Partial<Post> & Pick<Post, 'authorId'>,
): Promise<Post> {
  const { id, ...rest } = fields;
  return model<Post>(db, 'Post').create({
    _id: id ?? randomUUID(),
    type: PostType.POST,
    status: PostStatus.PUBLISHED,
    viewCount: 0,
    publishedAt: new Date(),
    ...rest,
  });
}

export function createMedia(
  db: MongoService,
  fields: Partial<MediaAsset> = {},
): Promise<MediaAsset> {
  const { id, ...rest } = fields;
  const mediaId = id ?? randomUUID();
  return model<MediaAsset>(db, 'MediaAsset').create({
    _id: mediaId,
    type: MediaType.VIDEO,
    status: MediaStatus.WAITING_UPLOAD,
    position: 0,
    publicId: `vedora/videos/${mediaId}`,
    captionStatus: CaptionStatus.NONE,
    captions: [],
    ...rest,
  });
}

const COLLECTION_MODEL: Record<'users' | 'posts' | 'recipes', string> = {
  users: 'User',
  posts: 'Post',
  recipes: 'Recipe',
};

/** Deletes a document through its Mongoose model so schema `onDelete` hooks run. */
export async function deleteWithCascade(
  db: MongoService,
  collection: 'users' | 'posts' | 'recipes',
  id: string,
): Promise<number> {
  const { deletedCount } = await db.withTransaction((session) =>
    db.connection
      .model(COLLECTION_MODEL[collection])
      .deleteOne({ _id: id }, { session })
      .exec(),
  );
  return deletedCount;
}
