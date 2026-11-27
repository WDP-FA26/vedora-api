import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { SupportSyncService } from '../../support/support-sync.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { extractMarkdownMediaUrls } from '../../common/text.js';
import {
  afterCursor,
  createCursorPaginatedResponse,
} from '../../common/pagination/index.js';
import { lockDocument } from '../../mongo/document-lock.js';
import {
  Post,
  PostRemovalActor,
  PostStatus,
  PostType,
  Recipe,
} from '../../mongo/models.js';
import { MongoService } from '../../mongo/mongo.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../storage/storage.service.js';
import {
  BlogDetailDto,
  CreateBlogDto,
  MyBlogsQueryDto,
  UpdateBlogDto,
} from '../dto/blog.dto.js';
import { PostPageDto } from '../dto/post-response.dto.js';
import { PostsQueryService } from '../posts-query.service.js';
import { PostSearchIndexService } from '../search/post-search-index.service.js';
import { MediaService } from '../../media/media.service.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import { coverFromContent } from './blog-cover.js';

@Injectable()
export class BlogsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly postsQuery: PostsQueryService,
    private readonly storage: StorageService,
    private readonly mediaService: MediaService,
    @InjectModel(Post.name) private readonly postsModel: Model<Post>,
    @InjectModel(Recipe.name) private readonly recipesModel: Model<Recipe>,
    @Optional() private readonly cloudinary?: CloudinaryService,
    @Optional() private readonly searchIndex?: PostSearchIndexService,
    @Optional() private readonly supportSync?: SupportSyncService,
  ) {}

  async create(authorId: string, dto: CreateBlogDto): Promise<BlogDetailDto> {
    this.validateCover(dto.coverImageUrl);
    const content = dto.content ?? '';
    this.validateContentMedia(content);
    const requested = this.requestedStatus(PostStatus.DRAFT, dto.status);
    this.validatePublication(requested, content);
    const status =
      requested === PostStatus.PUBLISHED ? PostStatus.PROCESSING : requested;
    await this.validateRecipes(dto.recipeIds);
    const now = new Date();
    const post = await this.postsModel.create({
      _id: randomUUID(),
      authorId,
      type: PostType.BLOG,
      status,
      body: null,
      blog: {
        title: dto.title,
        content,
        excerpt: this.excerpt(content),
        coverImageUrl: this.coverOf(content),
        recipeIds: dto.recipeIds ?? [],
      },
      searchIndexedAt: null,
      viewCount: 0,
      moderation: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (status === PostStatus.PROCESSING) {
      this.mediaService.settlePostsLater([post.id]);
      return this.loadDetail(post.id, authorId);
    }
    return this.toDetail(post, authorId);
  }

  async findOne(id: string, viewerId?: string): Promise<BlogDetailDto> {
    const post = await this.postsModel
      .findOne({ _id: id, type: PostType.BLOG })
      .exec();
    const authorDeleted =
      post?.status === PostStatus.REMOVED &&
      post.removal?.removedByRole === PostRemovalActor.AUTHOR;
    if (
      !post ||
      authorDeleted ||
      (post.status !== PostStatus.PUBLISHED && post.authorId !== viewerId)
    ) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
    }
    return this.toDetail(post, viewerId);
  }

  async listMine(
    authorId: string,
    query: MyBlogsQueryDto,
  ): Promise<PostPageDto> {
    const filter: Record<string, unknown> = {
      authorId,
      type: PostType.BLOG,
      ...(query.status
        ? { status: query.status }
        : {
            $or: [
              { status: { $ne: PostStatus.REMOVED } },
              { 'removal.removedByRole': PostRemovalActor.ADMIN },
            ],
          }),
    };
    if (query.cursor) {
      const cursor = await this.postsModel
        .findOne({ ...filter, _id: query.cursor })
        .exec();
      if (!cursor)
        throw new InvalidInputException('BAD_REQUEST', 'Invalid blog cursor');
      Object.assign(
        filter,
        afterCursor('createdAt', { value: cursor.createdAt, id: cursor.id }),
      );
    }
    const rows = await this.postsModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const page = createCursorPaginatedResponse(rows, query.limit);
    return {
      items: await this.postsQuery.toResponses(page.items, authorId),
      nextCursor: page.nextCursor,
    };
  }

  async update(
    id: string,
    authorId: string,
    dto: UpdateBlogDto,
  ): Promise<BlogDetailDto> {
    if (Object.values(dto).every((value) => value === undefined))
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Provide at least one blog field',
      );
    this.validateCover(dto.coverImageUrl);
    if (dto.content !== undefined) this.validateContentMedia(dto.content);
    await this.validateRecipes(dto.recipeIds);
    let needsReview = false;
    await this.mongo.withTransaction(async (session) => {
      const current = await this.lockOwned(session, id, authorId);
      const blog = current.blog;
      if (!blog)
        throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
      if (current.status === PostStatus.REMOVED) {
        if (current.removal?.removedByRole === PostRemovalActor.AUTHOR) {
          throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
        }
        throw new StateConflictException(
          'POST_NOT_EDITABLE',
          'A removed blog cannot be edited',
        );
      }
      if (this.supportSync) {
        await this.supportSync.assertNoActiveAppeal(id, session);
      }
      const requested = this.requestedStatus(current.status, dto.status);
      const content = dto.content ?? blog.content;
      this.validatePublication(requested, content);
      const changesReviewedContent =
        dto.title !== undefined || dto.content !== undefined;
      needsReview =
        requested === PostStatus.PUBLISHED &&
        (current.status !== PostStatus.PUBLISHED || changesReviewedContent);
      const status = needsReview ? PostStatus.PROCESSING : requested;
      const now = new Date();
      await this.postsModel
        .updateOne(
          { _id: id },
          {
            $set: {
              status,
              publishedAt: current.publishedAt,
              'blog.title': dto.title ?? blog.title,
              'blog.content': content,
              'blog.excerpt':
                dto.content !== undefined
                  ? this.excerpt(dto.content)
                  : blog.excerpt,
              'blog.coverImageUrl': this.coverOf(content),
              'blog.recipeIds': dto.recipeIds ?? blog.recipeIds,
              updatedAt: now,
            },
          },
          { session },
        )
        .exec();
    });
    if (needsReview) this.mediaService.settlePostsLater([id]);
    return this.loadDetail(id, authorId);
  }

  private requestedStatus(
    current: PostStatus,
    requested: 'DRAFT' | 'PUBLISHED' | undefined,
  ): PostStatus {
    if (requested === 'PUBLISHED') return PostStatus.PUBLISHED;
    if (requested === 'DRAFT') return PostStatus.DRAFT;
    if (current === PostStatus.REJECTED) return PostStatus.DRAFT;
    if (
      current === PostStatus.PROCESSING ||
      current === PostStatus.PENDING_REVIEW
    ) {
      return PostStatus.PUBLISHED;
    }
    return current;
  }

  async remove(id: string, authorId: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      const current = await this.lockOwned(session, id, authorId);
      if (current.status === PostStatus.REMOVED) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
      }
      if (this.supportSync) {
        await this.supportSync.assertNoActiveAppeal(id, session);
      }
      const now = new Date();
      await this.postsModel
        .updateOne(
          { _id: id },
          {
            $set: {
              status: PostStatus.REMOVED,
              removal: {
                removedById: authorId,
                removedByRole: PostRemovalActor.AUTHOR,
                removedAt: now,
                previousStatus: current.status,
                reason: null,
                restoredById: null,
                restoredAt: null,
              },
              searchIndexedAt: null,
            },
          },
          { session },
        )
        .exec();
    });
    if (this.searchIndex) {
      await this.searchIndex.remove(id);
    }
  }

  private async lockOwned(
    session: ClientSession,
    id: string,
    authorId: string,
  ) {
    await lockDocument(this.mongo, session, 'post', id);
    const owned = await this.postsModel
      .findOne({ _id: id, authorId, type: PostType.BLOG })
      .session(session)
      .exec();
    if (!owned)
      throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
    return owned;
  }

  private validatePublication(status: PostStatus, content: string) {
    if (status === PostStatus.PUBLISHED && content.trim().length === 0) {
      throw new InvalidInputException(
        'BLOG_CONTENT_REQUIRED',
        'A published blog needs content',
      );
    }
  }

  private coverOf(content: string): string | null {
    return coverFromContent(content, (url) => this.isAllowedCover(url));
  }

  private isAllowedCover(url: string): boolean {
    return this.storage.keyFromPublicUrl(StorageTarget.Blogs, url) !== null;
  }

  private validateCover(url: string | null | undefined) {
    if (!url || this.isAllowedCover(url)) return;
    throw new InvalidInputException(
      'BLOG_COVER_NOT_ALLOWED',
      'A cover must be an image in blog storage',
    );
  }

  private validateContentMedia(content: string) {
    for (const url of extractMarkdownMediaUrls(content)) {
      if (this.storage.keyFromPublicUrl(StorageTarget.Blogs, url)) continue;
      if (this.cloudinary?.isBlogVideoUrl?.(url)) continue;
      throw new InvalidInputException(
        'BLOG_MEDIA_NOT_ALLOWED',
        'Blog media must be uploaded through Vedora storage',
      );
    }
  }

  private async validateRecipes(ids?: string[]) {
    if (!ids?.length) return;
    const recipes = await this.recipesModel
      .find({ _id: { $in: ids } })
      .select('_id')
      .exec();
    const found = new Set(recipes.map(({ id }) => id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new InvalidInputException(
        'BLOG_RECIPE_NOT_FOUND',
        'Some linked recipes do not exist',
        { recipeIds: missing },
      );
    }
  }

  private excerpt(content: string) {
    return Array.from(content.replace(/\s+/g, ' ').trim())
      .slice(0, runtimeConfig.BLOG_EXCERPT_MAX_LENGTH)
      .join('');
  }

  private async loadDetail(
    id: string,
    viewerId: string,
  ): Promise<BlogDetailDto> {
    const post = await this.postsModel.findOne({ _id: id }).exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
    return this.toDetail(post, viewerId);
  }

  private async toDetail(
    post: Post,
    viewerId?: string,
  ): Promise<BlogDetailDto> {
    const [response] = await this.postsQuery.toResponses([post], viewerId);
    if (!response || !post.blog)
      throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
    return {
      ...response,
      content: post.blog.content,
      updatedAt: post.updatedAt,
    };
  }
}
