import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  afterCursor,
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination';
import { MediaService } from '../media/media.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  MediaStatus,
  Blog,
  BlogRecipe,
  MediaAsset,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  PostStatus,
  Recipe,
  User,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { deleteWithReferences } from '../mongo/relations';
import { MAX_FEED_RESULTS, PostFeedService } from './search/post-feed.service';
import { PostSearchIndexService } from './search/post-search-index.service';
import {
  MAX_SEARCH_RESULTS,
  PostSearchService,
} from './search/post-search.service';
import { CreatePostDto } from './dto/create-post.dto';
import { FEED_CURSOR, FeedQueryDto } from './dto/feed-query.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { SearchPostsQueryDto } from './dto/search-posts-query.dto';
import { loadPostRelations, type PostRelationModels } from './post-relations';

@Injectable()
export class PostsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly mediaService: MediaService,
    private readonly cloudinary: CloudinaryService,
    private readonly searchIndex: PostSearchIndexService,
    private readonly postSearch: PostSearchService,
    private readonly postFeed: PostFeedService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostRepost.name)
    private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Blog.name) private readonly blogs: Model<Blog>,
    @InjectModel(BlogRecipe.name)
    private readonly blogRecipes: Model<BlogRecipe>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
  ) {}

  /** The collections `loadPostRelations` joins against. */
  private get relationModels(): PostRelationModels {
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

  /**
   * Creates the post right away, even while its video is still processing:
   * it stays PROCESSING (author-only) and publishes when the video is ready.
   */
  async create(authorId: string, dto: CreatePostDto): Promise<PostResponseDto> {
    const body = dto.body || null;
    const mediaIds = dto.mediaIds ?? [];
    if (!body && mediaIds.length === 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'EMPTY_POST',
        message: 'A post needs text or a video',
      });
    }

    const id = randomUUID();
    await this.mongo.withTransaction(async (session) => {
      await this.posts.create(
        [
          {
            _id: id,
            authorId,
            type: dto.type,
            status: PostStatus.PROCESSING,
            body,
            searchIndexedAt: null,
            viewCount: 0,
            publishedAt: null,
          },
        ],
        { session },
      );
      await this.mediaService.claimForPost(session, authorId, id, mediaIds);
    });
    await this.mediaService.settlePosts([id]);
    // A text-only post is published by now; one with video is indexed by the
    // catch-up cron once Cloudinary finishes.
    this.searchIndex.schedule();

    return this.load(id, authorId);
  }

  /** Published posts matching `q`, best match first. */
  async search(
    query: SearchPostsQueryDto,
    viewerId?: string,
  ): Promise<PostPageDto> {
    const offset = query.cursor ?? 0;
    const limit = Math.min(query.limit, MAX_SEARCH_RESULTS - offset);
    if (limit <= 0) return { items: [], nextCursor: null };

    const { ids, hasMore } = await this.postSearch.search(
      query.q,
      offset,
      limit,
    );
    const posts = await this.posts.find({ _id: { $in: ids } }).exec();
    const found = new Set(posts.map(({ id }) => id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      void this.postSearch.prune(missing).catch(() => undefined);
    }
    const published = new Map(
      (
        await this.toResponses(
          posts.filter(({ status }) => status === PostStatus.PUBLISHED),
          viewerId,
        )
      ).map((post) => [post.id, post]),
    );
    return {
      items: ids.flatMap((id) => published.get(id) ?? []),
      nextCursor:
        hasMore && offset + limit < MAX_SEARCH_RESULTS
          ? String(offset + limit)
          : null,
    };
  }

  /** The viewer's "for you" feed; see `PostFeedService`. */
  async feed(query: FeedQueryDto, viewerId: string): Promise<PostPageDto> {
    const cursor = query.cursor ? FEED_CURSOR.exec(query.cursor) : null;
    const offset = cursor ? Number(cursor[1]) : 0;
    const asOf = cursor ? new Date(Number(cursor[2])) : new Date();
    const limit = Math.min(query.limit, MAX_FEED_RESULTS - offset);
    if (limit <= 0) return { items: [], nextCursor: null };

    // One extra id tells whether another page follows.
    const ids = await this.postFeed.feed(viewerId, asOf, offset + limit + 1);
    const page = ids.slice(offset, offset + limit);
    const posts = await this.posts
      .find({ status: PostStatus.PUBLISHED, _id: { $in: page } })
      .exec();
    const found = new Map(
      (await this.toResponses(posts, viewerId)).map((post) => [post.id, post]),
    );
    const next = offset + limit;
    return {
      items: page.flatMap((id) => found.get(id) ?? []),
      nextCursor:
        ids.length > next && next < MAX_FEED_RESULTS
          ? `${next}.${asOf.getTime()}`
          : null,
    };
  }

  async list(
    query: ListPostsQueryDto,
    viewerId?: string,
  ): Promise<PostPageDto> {
    const filter = {
      status: PostStatus.PUBLISHED,
      ...(query.authorId && { authorId: query.authorId }),
      ...(query.type && { type: query.type }),
    };
    if (query.cursor) {
      const cursor = await this.posts
        .findOne({
          ...filter,
          _id: query.cursor,
        })
        .exec();
      if (!cursor?.publishedAt) return { items: [], nextCursor: null };
      Object.assign(
        filter,
        afterCursor('publishedAt', {
          value: cursor.publishedAt,
          id: cursor.id,
        }),
      );
    }
    const rows = await this.posts
      .find(filter)
      .sort({ publishedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const page = createCursorPaginatedResponse(rows, query.limit);
    return {
      items: await this.toResponses(page.items, viewerId),
      nextCursor: page.nextCursor,
    };
  }

  /** The published posts a user saved, most recently saved first. */
  async listBookmarks(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PostPageDto> {
    const filter: Record<string, unknown> = { userId };
    if (query.cursor) {
      // The cursor is the post id; the bookmark gives its place in the order.
      const cursor = await this.bookmarks
        .findOne({ userId, postId: query.cursor })
        .exec();
      if (!cursor) return { items: [], nextCursor: null };
      Object.assign(
        filter,
        afterCursor('createdAt', { value: cursor.createdAt, id: cursor.id }),
      );
    }
    const rows = await this.bookmarks
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const posts = await this.posts
      .find({ _id: { $in: rows.map(({ postId }) => postId) } })
      .exec();
    const postById = new Map(posts.map((post) => [post.id, post]));
    // MongoDB has no relation filters: unpublished posts drop out here.
    const page = createCursorPaginatedResponse(
      rows
        .flatMap(({ postId }) => postById.get(postId) ?? [])
        .filter(({ status }) => status === PostStatus.PUBLISHED),
      query.limit,
    );
    return {
      items: await this.toResponses(page.items, userId),
      nextCursor: page.nextCursor,
    };
  }

  async findOne(id: string, viewerId?: string): Promise<PostResponseDto> {
    const post = await this.posts.findOne({ _id: id }).exec();
    const isAuthor = viewerId !== undefined && post?.authorId === viewerId;
    if (!post || (post.status !== PostStatus.PUBLISHED && !isAuthor)) {
      throw new NotFoundException('Post not found');
    }

    // Without webhooks, the author's polling is what moves the video along.
    if (
      post.status === PostStatus.PROCESSING &&
      !this.cloudinary.webhooksEnabled
    ) {
      const pending = await this.media
        .find({
          postId: id,
          status: {
            $in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING],
          },
        })
        .exec();
      for (const media of pending) {
        await this.mediaService.refresh(media);
      }
      await this.mediaService.settlePosts([id]);
    }
    return this.load(id, viewerId);
  }

  async remove(id: string, authorId: string): Promise<void> {
    const post = await this.posts
      .findOne({ _id: id })
      .select('authorId')
      .exec();
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== authorId) {
      throw new ForbiddenException('Only the author can delete this post');
    }
    await this.destroy(id);
  }

  /** Deletes anyone's post; the caller has checked the account is an admin. */
  async removeAsAdmin(id: string): Promise<void> {
    const post = await this.posts.findOne({ _id: id }).select('_id').exec();
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    await this.destroy(id);
  }

  private async destroy(id: string): Promise<void> {
    const media = await this.media.find({ postId: id }).select('_id').exec();
    await this.mongo.withTransaction((session) =>
      deleteWithReferences(this.mongo.db, session, 'posts', { _id: id }),
    );
    await this.searchIndex.remove(id);
    // The media rows were detached (onDelete SetNull); remove them from
    // Cloudinary the same way as discarded uploads, retried until confirmed.
    await this.mediaService.discard({
      _id: { $in: media.map((item) => item.id) },
    });
  }

  private async load(id: string, viewerId?: string): Promise<PostResponseDto> {
    const post = await this.posts.findOne({ _id: id }).exec();
    if (!post) throw new NotFoundException('Post not found');
    const [response] = await this.toResponses([post], viewerId);
    return response;
  }

  /** Post cards for `posts`, in the same order. */
  async toResponses(
    posts: readonly Post[],
    viewerId?: string,
  ): Promise<PostResponseDto[]> {
    const relations = await loadPostRelations(
      this.relationModels,
      posts,
      viewerId,
    );
    return posts.flatMap((post) => {
      const related = relations.get(post.id);
      if (!related) return [];
      return [
        {
          id: post.id,
          type: post.type,
          status: post.status,
          body: post.body,
          blog: related.blog,
          publishedAt: post.publishedAt,
          createdAt: post.createdAt,
          author: related.author,
          media: related.media.map((media) =>
            this.mediaService.toResponse(media),
          ),
          commentCount: related.commentCount,
          likeCount: related.likeCount,
          isLiked: related.isLiked,
          repostCount: related.repostCount,
          isReposted: related.isReposted,
          isBookmarked: related.isBookmarked,
          viewCount: post.viewCount,
        },
      ];
    });
  }
}
