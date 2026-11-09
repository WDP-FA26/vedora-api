import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  afterCursor,
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination/index.js';
import { ModerationSettingsService } from '../moderation/moderation-settings.service.js';
import { MediaService } from '../media/media.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import {
  MediaStatus,
  MediaAsset,
  Follow,
  Post,
  PostBookmark,
  PostStatus,
  PostType,
} from '../mongo/models.js';
import {
  MAX_FEED_RESULTS,
  PostFeedService,
} from './search/post-feed.service.js';
import {
  MAX_SEARCH_RESULTS,
  PostSearchService,
} from './search/post-search.service.js';
import { FEED_CURSOR, FeedQueryDto } from './dto/feed-query.dto.js';
import { ListPostsQueryDto } from './dto/list-posts-query.dto.js';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto.js';
import { SearchPostsQueryDto } from './dto/search-posts-query.dto.js';
import { PostRelationsService } from './post-relations.service.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';

@Injectable()
export class PostsQueryService {
  constructor(
    private readonly mediaService: MediaService,
    private readonly cloudinary: CloudinaryService,
    private readonly postSearch: PostSearchService,
    private readonly postFeed: PostFeedService,
    private readonly relations: PostRelationsService,
    private readonly moderationSettings: ModerationSettingsService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
  ) {}

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

  async feed(query: FeedQueryDto, viewerId: string): Promise<PostPageDto> {
    const cursor = query.cursor ? FEED_CURSOR.exec(query.cursor) : null;
    const offset = cursor ? Number(cursor[1]) : 0;
    const asOf = cursor ? new Date(Number(cursor[2])) : new Date();
    const limit = Math.min(query.limit, MAX_FEED_RESULTS - offset);
    if (limit <= 0) return { items: [], nextCursor: null };

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

  async listBookmarks(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PostPageDto> {
    const filter: Record<string, unknown> = { userId };
    if (query.cursor) {
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

  async listFollowing(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PostPageDto> {
    const follows = await this.follows
      .find({ followerId: userId })
      .select('followingId')
      .exec();
    const authorIds = follows.map(({ followingId }) => followingId);
    if (authorIds.length === 0) return { items: [], nextCursor: null };
    const filter: Record<string, unknown> = {
      authorId: { $in: authorIds },
      status: PostStatus.PUBLISHED,
      type: PostType.POST,
    };
    if (query.cursor) {
      const cursor = await this.posts
        .findOne({ _id: query.cursor, authorId: { $in: authorIds } })
        .exec();
      if (!cursor) return { items: [], nextCursor: null };
      Object.assign(
        filter,
        afterCursor('createdAt', { value: cursor.createdAt, id: cursor.id }),
      );
    }
    const rows = await this.posts
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const page = createCursorPaginatedResponse(rows, query.limit);
    return {
      items: await this.toResponses(page.items, userId),
      nextCursor: page.nextCursor,
    };
  }

  async findOne(id: string, viewerId?: string): Promise<PostResponseDto> {
    const post = await this.posts.findOne({ _id: id }).exec();
    const isAuthor = viewerId !== undefined && post?.authorId === viewerId;
    if (!post || (post.status !== PostStatus.PUBLISHED && !isAuthor)) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    }

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

  async load(id: string, viewerId?: string): Promise<PostResponseDto> {
    const post = await this.posts.findOne({ _id: id }).exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    const [response] = await this.toResponses([post], viewerId);
    return response;
  }

  async toResponses(
    posts: readonly Post[],
    viewerId?: string,
  ): Promise<PostResponseDto[]> {
    const relations = await this.relations.hydrate(posts, viewerId);
    const reasonTexts = await this.moderationSettings.reasonTexts();
    return posts.flatMap((post) => {
      const related = relations.get(post.id);
      if (!related) return [];
      return [
        {
          id: post.id,
          type: post.type,
          status: post.status,
          moderationVerdict:
            post.status === PostStatus.REJECTED
              ? (post.moderation?.verdict ?? null)
              : null,
          moderationReason:
            post.status === PostStatus.REJECTED && post.moderation
              ? (reasonTexts.get(post.moderation.verdict) ?? null)
              : null,
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
