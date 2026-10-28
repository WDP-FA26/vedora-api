import type { Model } from 'mongoose';
import type { Blog, BlogRecipe, Recipe } from '../../mongo/models';
import type { BlogSummaryDto } from '../dto/blog-summary.dto';

/** The collections a blog summary joins against. */
export interface BlogQueryModels {
  blogs: Model<Blog>;
  blogRecipes: Model<BlogRecipe>;
  recipes: Model<Recipe>;
}

/**
 * Feed reads never load the full article: the summary of each blog post in
 * `postIds`, with its linked recipes in order. MongoDB has no nested
 * selects, so the blogs, their recipe links and the recipes are three
 * queries.
 */
export async function loadBlogSummaries(
  models: BlogQueryModels,
  postIds: readonly string[],
): Promise<Map<string, BlogSummaryDto>> {
  if (postIds.length === 0) return new Map();
  const ids = [...postIds];
  const [blogs, links] = await Promise.all([
    models.blogs
      .find({ _id: { $in: ids } })
      .select('title coverImageUrl excerpt')
      .exec(),
    models.blogRecipes
      .find({ postId: { $in: ids } })
      .sort({ position: 1 })
      .exec(),
  ]);
  const recipes = await models.recipes
    .find({ _id: { $in: [...new Set(links.map(({ recipeId }) => recipeId))] } })
    .select('title imageUrl')
    .exec();
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  return new Map(
    blogs.map((blog) => [
      blog.id,
      {
        title: blog.title,
        coverImageUrl: blog.coverImageUrl,
        excerpt: blog.excerpt,
        recipes: links
          .filter((link) => link.postId === blog.id)
          .flatMap(({ recipeId }) => {
            const recipe = recipeById.get(recipeId);
            return recipe
              ? [
                  {
                    id: recipe.id,
                    title: recipe.title,
                    imageUrl: recipe.imageUrl,
                  },
                ]
              : [];
          }),
      },
    ]),
  );
}
