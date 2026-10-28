import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isURL } from 'class-validator';
import type { ClientSession } from 'mongodb';
import type { Model } from 'mongoose';
import {
  afterCursor,
  createCursorPaginatedResponse,
} from '../common/pagination';
import { lockDocument } from '../mongo/document-lock';
import {
  Blog,
  BlogRecipe,
  Post,
  PostStatus,
  PostType,
  Recipe,
  type Stored,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { deleteWithReferences } from '../mongo/relations';
import { StorageService, StorageTarget } from '../storage/storage.service';
import {
  BlogDetailDto,
  CreateBlogDto,
  MyBlogsQueryDto,
  UpdateBlogDto,
} from './dto/blog.dto';
import { PostPageDto } from './dto/post-response.dto';
import { PostsService } from './posts.service';

@Injectable()
export class BlogsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly posts: PostsService,
    private readonly storage: StorageService,
    @InjectModel(Post.name) private readonly postsModel: Model<Post>,
    @InjectModel(Blog.name) private readonly blogsModel: Model<Blog>,
    @InjectModel(BlogRecipe.name)
    private readonly blogRecipes: Model<BlogRecipe>,
    @InjectModel(Recipe.name) private readonly recipesModel: Model<Recipe>,
  ) {}

  async create(authorId: string, dto: CreateBlogDto): Promise<BlogDetailDto> {
    this.validateCover(dto.coverImageUrl);
    const status: PostStatus =
      (dto.status as PostStatus | undefined) ?? PostStatus.DRAFT;
    const content = dto.content ?? '';
    this.validatePublication(status, content);
    await this.validateRecipes(dto.recipeIds);
    const id = randomUUID();
    // The post, its blog and its recipe links are written together.
    await this.mongo.withTransaction(async (session) => {
      const now = new Date();
      await this.collections.posts.insertOne(
        {
          _id: id,
          authorId,
          type: PostType.BLOG,
          status,
          body: null,
          searchIndexedAt: null,
          viewCount: 0,
          publishedAt: status === PostStatus.PUBLISHED ? now : null,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.collections.blogs.insertOne(
        {
          _id: id,
          title: dto.title,
          content,
          excerpt: this.excerpt(content),
          coverImageUrl: dto.coverImageUrl ?? null,
          updatedAt: now,
        },
        { session },
      );
      await this.linkRecipes(session, id, dto.recipeIds ?? []);
    });
    return this.loadDetail(id, authorId);
  }

  async findOne(id: string, viewerId?: string): Promise<BlogDetailDto> {
    const post = await this.postsModel
      .findOne({ _id: id, type: PostType.BLOG })
      .exec();
    if (
      !post ||
      (post.status !== PostStatus.PUBLISHED && post.authorId !== viewerId)
    ) {
      throw new NotFoundException('Blog not found');
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
      if (!cursor) throw new BadRequestException('Invalid blog cursor');
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
      items: await this.posts.toResponses(page.items, authorId),
      nextCursor: page.nextCursor,
    };
  }

  async update(
    id: string,
    authorId: string,
    dto: UpdateBlogDto,
  ): Promise<BlogDetailDto> {
    if (Object.values(dto).every((value) => value === undefined))
      throw new BadRequestException('Provide at least one blog field');
    this.validateCover(dto.coverImageUrl);
    await this.validateRecipes(dto.recipeIds);
    await this.mongo.withTransaction(async (session) => {
      const current = await this.lockOwned(session, id, authorId);
      const blog = await this.collections.blogs.findOne(
        { _id: id },
        { session },
      );
      if (!blog) throw new NotFoundException('Blog not found');
      const status: PostStatus =
        (dto.status as PostStatus | undefined) ?? current.status;
      const content = dto.content ?? blog.content;
      this.validatePublication(status, content);
      const now = new Date();
      await this.collections.posts.updateOne(
        { _id: id },
        {
          $set: {
            status,
            // Edits and re-publication keep the original feed position.
            publishedAt:
              status === PostStatus.PUBLISHED
                ? (current.publishedAt ?? now)
                : current.publishedAt,
            updatedAt: now,
          },
        },
        { session },
      );
      await this.collections.blogs.updateOne(
        { _id: id },
        {
          $set: {
            ...(dto.title !== undefined && { title: dto.title }),
            ...(dto.content !== undefined && {
              content: dto.content,
              excerpt: this.excerpt(dto.content),
            }),
            ...(dto.coverImageUrl !== undefined && {
              coverImageUrl: dto.coverImageUrl,
            }),
            updatedAt: now,
          },
        },
        { session },
      );
      if (dto.recipeIds !== undefined) {
        await this.collections.blogRecipes.deleteMany(
          { postId: id },
          { session },
        );
        await this.linkRecipes(session, id, dto.recipeIds);
      }
    });
    return this.loadDetail(id, authorId);
  }

  async remove(id: string, authorId: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      await this.lockOwned(session, id, authorId);
      // The post owns its blog, recipe links and interactions.
      await deleteWithReferences(this.mongo.db, session, 'posts', {
        _id: id,
      });
    });
  }

  private get collections() {
    const database = this.mongo.db;
    return {
      posts: database.collection<Stored<Post>>('posts'),
      blogs: database.collection<Stored<Blog>>('blogs'),
      blogRecipes: database.collection<Stored<BlogRecipe>>('blog_recipes'),
    };
  }

  /** Locks and returns the author's blog post. */
  private async lockOwned(
    session: ClientSession,
    id: string,
    authorId: string,
  ) {
    // Serialize edit/publish/delete so publication cannot validate an old
    // content value while another edit replaces it with an empty draft.
    await lockDocument(this.mongo.db, session, 'post', id);
    const owned = await this.collections.posts.findOne(
      { _id: id, authorId, type: PostType.BLOG },
      { session },
    );
    if (!owned) throw new NotFoundException('Blog not found');
    return owned;
  }

  private async linkRecipes(
    session: ClientSession,
    postId: string,
    recipeIds: string[],
  ): Promise<void> {
    if (recipeIds.length === 0) return;
    await this.collections.blogRecipes.insertMany(
      recipeIds.map((recipeId, position) => ({
        _id: randomUUID(),
        postId,
        recipeId,
        position,
      })),
      { session },
    );
  }

  private validatePublication(status: PostStatus, content: string) {
    if (status === PostStatus.PUBLISHED && content.trim().length === 0) {
      throw new BadRequestException({
        code: 'BLOG_CONTENT_REQUIRED',
        message: 'A published blog needs content',
        statusCode: 400,
        error: 'Bad Request',
      });
    }
  }

  /**
   * A cover is any https image on a public host, or an image in Vedora's own
   * blog storage, which serves plain http outside production. The first image
   * of the article becomes the cover, whether uploaded or AI-generated.
   */
  private validateCover(url: string | null | undefined) {
    if (!url) return;
    if (isURL(url, { protocols: ['https'], require_protocol: true })) return;
    if (this.storage.keyFromPublicUrl(StorageTarget.Blogs, url)) return;
    throw new BadRequestException({
      code: 'BLOG_COVER_NOT_ALLOWED',
      message: 'A cover must be an https link or an image in blog storage',
      statusCode: 400,
      error: 'Bad Request',
    });
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
      throw new BadRequestException({
        code: 'BLOG_RECIPE_NOT_FOUND',
        message: 'Some linked recipes do not exist',
        recipeIds: missing,
        statusCode: 400,
        error: 'Bad Request',
      });
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
    if (!post) throw new NotFoundException('Blog not found');
    return this.toDetail(post, viewerId);
  }

  private async toDetail(
    post: Post,
    viewerId?: string,
  ): Promise<BlogDetailDto> {
    const [response] = await this.posts.toResponses([post], viewerId);
    const blog = await this.blogsModel
      .findOne({ _id: post.id })
      .select('content updatedAt')
      .exec();
    if (!response || !blog) throw new NotFoundException('Blog not found');
    return { ...response, content: blog.content, updatedAt: blog.updatedAt };
  }
}
