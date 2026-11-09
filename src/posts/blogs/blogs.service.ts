import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isURL } from 'class-validator';
import type { ClientSession, Model } from 'mongoose';
import {
  afterCursor,
  createCursorPaginatedResponse,
} from '../../common/pagination/index.js';
import { lockDocument } from '../../mongo/document-lock.js';
import { Post, PostStatus, PostType, Recipe } from '../../mongo/models.js';
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
import { PostModerationService } from '../../media/post-moderation.service.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';

@Injectable()
export class BlogsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly postsQuery: PostsQueryService,
    private readonly storage: StorageService,
    private readonly postModeration: PostModerationService,
    @InjectModel(Post.name) private readonly postsModel: Model<Post>,
    @InjectModel(Recipe.name) private readonly recipesModel: Model<Recipe>,
  ) {}

  async create(authorId: string, dto: CreateBlogDto): Promise<BlogDetailDto> {
    this.validateCover(dto.coverImageUrl);
    const requested = this.requestedStatus(PostStatus.DRAFT, dto.status);
    const content = dto.content ?? '';
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
        coverImageUrl: dto.coverImageUrl ?? null,
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
      await this.postModeration.settle([post.id]);
      return this.loadDetail(post.id, authorId);
    }
    return this.toDetail(post, authorId);
  }

  async findOne(id: string, viewerId?: string): Promise<BlogDetailDto> {
    const post = await this.postsModel
      .findOne({ _id: id, type: PostType.BLOG })
      .exec();
    if (
      !post ||
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
      ...(query.status && { status: query.status }),
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
    await this.validateRecipes(dto.recipeIds);
    let needsReview = false;
    await this.mongo.withTransaction(async (session) => {
      const current = await this.lockOwned(session, id, authorId);
      const blog = current.blog;
      if (!blog)
        throw new ResourceNotFoundException('NOT_FOUND', 'Blog not found');
      const requested = this.requestedStatus(current.status, dto.status);
      const content = dto.content ?? blog.content;
      this.validatePublication(requested, content);
      const changesReviewedContent =
        dto.title !== undefined ||
        dto.content !== undefined ||
        dto.coverImageUrl !== undefined;
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
              'blog.coverImageUrl':
                dto.coverImageUrl !== undefined
                  ? dto.coverImageUrl
                  : blog.coverImageUrl,
              'blog.recipeIds': dto.recipeIds ?? blog.recipeIds,
              updatedAt: now,
            },
          },
          { session },
        )
        .exec();
    });
    if (needsReview) await this.postModeration.settle([id]);
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
      await this.lockOwned(session, id, authorId);
      await this.postsModel.deleteOne({ _id: id }, { session }).exec();
    });
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

  private validateCover(url: string | null | undefined) {
    if (!url) return;
    if (isURL(url, { protocols: ['https'], require_protocol: true })) return;
    if (this.storage.keyFromPublicUrl(StorageTarget.Blogs, url)) return;
    throw new InvalidInputException(
      'BLOG_COVER_NOT_ALLOWED',
      'A cover must be an https link or an image in blog storage',
    );
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
      .slice(0, 280)
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
