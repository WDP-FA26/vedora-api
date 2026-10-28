import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Blog,
  BlogRecipe,
  MediaAsset,
  type Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  Recipe,
  User,
} from '../mongo/models';
import { loadBlogSummaries, type BlogQueryModels } from './blogs/blog-query';
import type { BlogSummaryDto } from './dto/blog-summary.dto';

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

/** The collections a post card joins against. */
interface PostRelationModels extends BlogQueryModels {
  users: Model<User>;
  media: Model<MediaAsset>;
  comments: Model<PostComment>;
  likes: Model<PostLike>;
  reposts: Model<PostRepost>;
  bookmarks: Model<PostBookmark>;
}

/**
 * Loads the author, media, blog summary, counts and the viewer's own
 * interactions of `posts`. MongoDB has no relation counts or nested
 * selects, so each is one query over all the posts at once.
 *
 * It owns the collections it joins, so the services that render post cards
 * depend on one collaborator instead of nine models.
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
    @InjectModel(Blog.name) private readonly blogs: Model<Blog>,
    @InjectModel(BlogRecipe.name)
    private readonly blogRecipes: Model<BlogRecipe>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
  ) {}

  private get models(): PostRelationModels {
    return {
      users: this.users,
      media: this.media,
      comments: this.comments,
      likes: this.likes,
      reposts: this.reposts,
      bookmarks: this.bookmarks,
      blogs: this.blogs,
      blogRecipes: this.blogRecipes,
      recipes: this.recipes,
    };
  }

  /** Relations of `posts`, keyed by post id. */
  async hydrate(
    posts: readonly Post[],
    viewerId?: string,
  ): Promise<Map<string, PostRelations>> {
    if (posts.length === 0) return new Map();
    const models = this.models;
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
      models.users
        .find({ _id: { $in: [...new Set(posts.map((p) => p.authorId))] } })
        .select('username fullName avatarUrl')
        .exec(),
      models.media.find(inPosts).sort({ position: 1 }).exec(),
      loadBlogSummaries(models, postIds),
      countByPost(models.comments, postIds),
      countByPost(models.likes, postIds),
      countByPost(models.reposts, postIds),
      viewerId
        ? models.likes.find({ userId: viewerId, ...inPosts }).exec()
        : [],
      viewerId
        ? models.reposts.find({ userId: viewerId, ...inPosts }).exec()
        : [],
      viewerId
        ? models.bookmarks.find({ userId: viewerId, ...inPosts }).exec()
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
