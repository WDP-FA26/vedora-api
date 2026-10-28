import type { ClientSession, Db, Document } from 'mongodb';

type CollectionName = string;

type OnDelete = 'cascade' | 'setNull' | 'restrict';

interface Reference {
  /** The collection holding the reference. */
  from: CollectionName;
  /** The stored field holding the referenced `_id`. */
  field: string;
  onDelete: OnDelete;
}

/**
 * Who points at each collection, and what happens to them when the target
 * is deleted. MongoDB has no referential actions, so `deleteWithReferences`
 * applies these; keep them in step with the schema classes.
 */
const REFERENCES: Partial<Record<CollectionName, Reference[]>> = {
  users: [
    { from: 'follows', field: 'followerId', onDelete: 'cascade' },
    { from: 'follows', field: 'followingId', onDelete: 'cascade' },
    { from: 'notifications', field: 'recipientId', onDelete: 'cascade' },
    { from: 'notifications', field: 'actorId', onDelete: 'cascade' },
    { from: 'follow_suggestions', field: 'userId', onDelete: 'cascade' },
    { from: 'follow_suggestions', field: 'candidateId', onDelete: 'cascade' },
    { from: 'suggestion_dismissals', field: 'userId', onDelete: 'cascade' },
    { from: 'profile_image_uploads', field: 'ownerId', onDelete: 'setNull' },
    { from: 'refresh_tokens', field: 'userId', onDelete: 'cascade' },
    { from: 'one_time_codes', field: 'userId', onDelete: 'cascade' },
    { from: 'posts', field: 'authorId', onDelete: 'cascade' },
    { from: 'post_comments', field: 'authorId', onDelete: 'cascade' },
    { from: 'post_likes', field: 'userId', onDelete: 'cascade' },
    { from: 'post_reposts', field: 'userId', onDelete: 'cascade' },
    { from: 'post_bookmarks', field: 'userId', onDelete: 'cascade' },
    { from: 'post_reports', field: 'reporterId', onDelete: 'cascade' },
    { from: 'post_reports', field: 'reviewedById', onDelete: 'setNull' },
    { from: 'media_assets', field: 'ownerId', onDelete: 'setNull' },
    { from: 'knowledge_documents', field: 'uploadedById', onDelete: 'setNull' },
    { from: 'verification_requests', field: 'userId', onDelete: 'cascade' },
    {
      from: 'verification_requests',
      field: 'reviewedById',
      onDelete: 'setNull',
    },
    { from: 'verification_proofs', field: 'ownerId', onDelete: 'setNull' },
    { from: 'recipes', field: 'createdById', onDelete: 'setNull' },
    { from: 'recipe_favorites', field: 'userId', onDelete: 'cascade' },
    { from: 'recipe_ratings', field: 'userId', onDelete: 'cascade' },
    { from: 'meal_plan_entries', field: 'userId', onDelete: 'cascade' },
    { from: 'ai_usage', field: 'userId', onDelete: 'cascade' },
  ],
  posts: [
    { from: 'notifications', field: 'postId', onDelete: 'cascade' },
    { from: 'blogs', field: '_id', onDelete: 'cascade' },
    { from: 'post_comments', field: 'postId', onDelete: 'cascade' },
    { from: 'post_likes', field: 'postId', onDelete: 'cascade' },
    { from: 'post_reposts', field: 'postId', onDelete: 'cascade' },
    { from: 'post_bookmarks', field: 'postId', onDelete: 'cascade' },
    { from: 'post_reports', field: 'postId', onDelete: 'cascade' },
    { from: 'media_assets', field: 'postId', onDelete: 'setNull' },
    { from: 'recipes', field: 'postId', onDelete: 'setNull' },
  ],
  blogs: [{ from: 'blog_recipes', field: 'postId', onDelete: 'cascade' }],
  payment_intents: [
    { from: 'payment_requests', field: 'intentId', onDelete: 'restrict' },
    {
      from: 'payment_webhook_receipts',
      field: 'intentId',
      onDelete: 'restrict',
    },
  ],
  verification_requests: [
    { from: 'verification_proofs', field: 'requestId', onDelete: 'setNull' },
  ],
  ingredients: [
    { from: 'recipe_ingredients', field: 'ingredientId', onDelete: 'restrict' },
    {
      from: 'ingredient_group_members',
      field: 'ingredientId',
      onDelete: 'cascade',
    },
    {
      from: 'incompatibility_rules',
      field: 'aIngredientId',
      onDelete: 'cascade',
    },
    {
      from: 'incompatibility_rules',
      field: 'bIngredientId',
      onDelete: 'cascade',
    },
  ],
  ingredient_groups: [
    { from: 'ingredient_group_members', field: 'groupId', onDelete: 'cascade' },
    { from: 'incompatibility_rules', field: 'aGroupId', onDelete: 'cascade' },
    { from: 'incompatibility_rules', field: 'bGroupId', onDelete: 'cascade' },
  ],
  recipes: [
    { from: 'blog_recipes', field: 'recipeId', onDelete: 'cascade' },
    { from: 'recipe_ingredients', field: 'recipeId', onDelete: 'cascade' },
    { from: 'recipe_favorites', field: 'recipeId', onDelete: 'cascade' },
    { from: 'recipe_ratings', field: 'recipeId', onDelete: 'cascade' },
    { from: 'meal_plan_entries', field: 'recipeId', onDelete: 'cascade' },
  ],
};

/** A delete refused because other documents still point at the target. */
export class RestrictedDeleteError extends Error {
  constructor(
    readonly collection: CollectionName,
    readonly referencedBy: CollectionName,
  ) {
    super(`${collection} is still referenced by ${referencedBy}`);
    this.name = 'RestrictedDeleteError';
  }
}

/**
 * Deletes the documents matching `filter` (stored field names: `_id`, not
 * `id`) and applies the onDelete rules of everything pointing at them, as
 * part of the caller's transaction. Returns how many were deleted.
 */
export async function deleteWithReferences(
  database: Db,
  session: ClientSession,
  collection: CollectionName,
  filter: Document,
): Promise<number> {
  const ids = await database
    .collection(collection)
    .distinct('_id', filter, { session });
  if (ids.length === 0) return 0;
  const references = REFERENCES[collection] ?? [];
  for (const reference of references) {
    if (reference.onDelete !== 'restrict') continue;
    const count = await database
      .collection(reference.from)
      .countDocuments(
        { [reference.field]: { $in: ids } },
        { limit: 1, session },
      );
    if (count > 0) throw new RestrictedDeleteError(collection, reference.from);
  }
  for (const reference of references) {
    const match = { [reference.field]: { $in: ids } };
    if (reference.onDelete === 'cascade') {
      await deleteWithReferences(database, session, reference.from, match);
    } else if (reference.onDelete === 'setNull') {
      await database
        .collection(reference.from)
        .updateMany(match, { $set: { [reference.field]: null } }, { session });
    }
  }
  const { deletedCount } = await database
    .collection(collection)
    .deleteMany({ _id: { $in: ids } }, { session });
  return deletedCount;
}
