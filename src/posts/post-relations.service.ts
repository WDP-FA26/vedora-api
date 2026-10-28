import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  MediaAsset,
  type Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  Recipe,
  User,
} from '../mongo/models.js';
import type { BlogSummaryDto } from './dto/blog-summary.dto.js';

/** What a post card shows besides the post itself. */
export interface PostRelations {
  author: Pick<User, 'id' | 'username' | 'fullName' | 'avatarUrl'>;
  media: MediaAsset[];
  blog: BlogSummaryDto | null;
  commentCount: number;
  likeCount: number;
  repostCount: number;
  isLiked: boolean;
  isReposted: boolean;
  isBookmarked: boolean;
}

/**
 * Loads the author, media, blog summary, counts and the viewer's own
 * interactions of `posts`.
 *
 * It owns the collections it joins, so the services that render post cards
 * depend on one collaborator instead of seven models.
 */
@Injectable()
export class PostRelationsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostRepost.name)
    private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
  ) {}

  /** Relations of `posts`, keyed by post id. */
  async hydrate(
    posts: readonly Post[],
    viewerId?: string,
  ): Promise<Map<string, PostRelations>> {
    if (posts.length === 0) return new Map();
    const postIds = posts.map(({ id }) => id);
    const inPosts = { postId: { $in: postIds } };
    const viewerPostIds = (rows: { postId: string }[]) =>
      new Set(rows.map(({ postId }) => postId));
    const [
      authors,
      media,
      blogs,
      comments,
      likes,
      reposts,
      liked,
      reposted,
      bookmarked,
    ] = await Promise.all([
      this.users
        .find({ _id: { $in: [...new Set(posts.map((p) => p.authorId))] } })
        .select('username fullName avatarUrl')
        .exec(),
      this.media.find(inPosts).sort({ position: 1 }).exec(),
      this.blogSummaries(posts),
      countByPost(this.comments, postIds),
      countByPost(this.likes, postIds),
      countByPost(this.reposts, postIds),
      viewerId ? this.likes.find({ userId: viewerId, ...inPosts }).exec() : [],
      viewerId
        ? this.reposts.find({ userId: viewerId, ...inPosts }).exec()
        : [],
      viewerId
        ? this.bookmarks.find({ userId: viewerId, ...inPosts }).exec()
        : [],
    ]);
    const authorById = new Map(authors.map((author) => [author.id, author]));
    const isLiked = viewerPostIds(liked);
    const isReposted = viewerPostIds(reposted);
    const isBookmarked = viewerPostIds(bookmarked);
    const relations = new Map<string, PostRelations>();
    for (const post of posts) {
      const author = authorById.get(post.authorId);
      if (!author) continue;
      relations.set(post.id, {
        author: {
          id: author.id,
          username: author.username,
          fullName: author.fullName,
          avatarUrl: author.avatarUrl,
        },
        media: media.filter((item) => item.postId === post.id),
        blog: blogs.get(post.id) ?? null,
        commentCount: comments.get(post.id) ?? 0,
        likeCount: likes.get(post.id) ?? 0,
        repostCount: reposts.get(post.id) ?? 0,
        isLiked: isLiked.has(post.id),
        isReposted: isReposted.has(post.id),
        isBookmarked: isBookmarked.has(post.id),
      });
    }
    return relations;
  }

  /**
   * Builds the summary of each blog post in `posts` from its embedded `blog`
   * subdocument, resolving linked recipes in order.
   */
  private async blogSummaries(
    posts: readonly Post[],
  ): Promise<Map<string, BlogSummaryDto>> {
    const blogPosts = posts.filter(
      (post): post is Post & { blog: NonNullable<Post['blog']> } =>
        post.blog !== null && post.blog !== undefined,
    );
    if (blogPosts.length === 0) return new Map();
    const recipeIds = [
      ...new Set(blogPosts.flatMap(({ blog }) => blog.recipeIds)),
    ];
    const recipes =
      recipeIds.length === 0
        ? []
        : await this.recipes
            .find({ _id: { $in: recipeIds } })
            .select('title imageUrl')
            .exec();
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    return new Map(
      blogPosts.map(({ id, blog }) => [
        id,
        {
          title: blog.title,
          coverImageUrl: blog.coverImageUrl,
          excerpt: blog.excerpt,
          recipes: blog.recipeIds.flatMap((recipeId) => {
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
}

async function countByPost<T extends { postId: string }>(
  model: Model<T>,
  postIds: string[],
): Promise<Map<string, number>> {
  const rows = await model.aggregate<{ _id: string; count: number }>([
    { $match: { postId: { $in: postIds } } },
    { $group: { _id: '$postId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}
