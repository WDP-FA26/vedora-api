import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PostStatus, PostType, Prisma } from '@prisma/client';
import { isURL } from 'class-validator';
import { createCursorPaginatedResponse } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { blogSummarySelect } from './blog-query';
import {
  BlogDetailDto,
  CreateBlogDto,
  MyBlogsQueryDto,
  UpdateBlogDto,
} from './dto/blog.dto';
import { PostPageDto } from './dto/post-response.dto';
import { postInclude, PostsService } from './posts.service';

const detailInclude = (viewerId?: string) => ({
  ...postInclude(viewerId),
  blog: {
    select: { ...blogSummarySelect, content: true, updatedAt: true },
  },
});

@Injectable()
export class BlogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly storage: StorageService,
  ) {}

  async create(authorId: string, dto: CreateBlogDto): Promise<BlogDetailDto> {
    this.validateCover(dto.coverImageUrl);
    return this.write(async (tx) => {
      const status = dto.status ?? PostStatus.DRAFT;
      const content = dto.content ?? '';
      this.validatePublication(status, content);
      await this.validateRecipes(tx, dto.recipeIds);
      const row = await tx.post.create({
        data: {
          authorId,
          type: PostType.BLOG,
          status,
          publishedAt: status === PostStatus.PUBLISHED ? new Date() : null,
          blog: {
            create: {
              title: dto.title,
              content,
              excerpt: this.excerpt(content),
              coverImageUrl: dto.coverImageUrl ?? null,
              recipes: { create: this.recipeLinks(dto.recipeIds ?? []) },
            },
          },
        },
        include: detailInclude(authorId),
      });
      return this.toDetail(row);
    });
  }

  async findOne(id: string, viewerId?: string): Promise<BlogDetailDto> {
    // Related rows may take multiple SQL statements; visibility and content
    // must use the same snapshot during concurrent draft edits.
    const [row] = await this.prisma.$transaction(
      [
        this.prisma.post.findUnique({
          where: { id },
          include: detailInclude(viewerId),
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (
      !row?.blog ||
      row.type !== PostType.BLOG ||
      (row.status !== PostStatus.PUBLISHED && row.authorId !== viewerId)
    ) {
      throw new NotFoundException('Blog not found');
    }
    return this.toDetail(row);
  }

  async listMine(
    authorId: string,
    query: MyBlogsQueryDto,
  ): Promise<PostPageDto> {
    const where: Prisma.PostWhereInput = {
      authorId,
      type: PostType.BLOG,
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.cursor) {
      const cursor = await this.prisma.post.findFirst({
        where: { ...where, id: query.cursor },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Invalid blog cursor');
    }
    const rows = await this.prisma.post.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: postInclude(authorId),
    });
    const page = createCursorPaginatedResponse(rows, query.limit);
    return {
      items: page.items.map((row) => this.posts.toResponse(row)),
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
    return this.write(async (tx) => {
      await this.lockOwned(tx, id, authorId);
      const current = await tx.post.findUniqueOrThrow({
        where: { id },
        include: { blog: true },
      });
      if (!current.blog) throw new NotFoundException('Blog not found');
      const status = dto.status ?? current.status;
      const content = dto.content ?? current.blog.content;
      this.validatePublication(status, content);
      await this.validateRecipes(tx, dto.recipeIds);
      const row = await tx.post.update({
        where: { id, authorId, type: PostType.BLOG },
        data: {
          status,
          // Edits and re-publication keep the original feed position.
          publishedAt:
            status === PostStatus.PUBLISHED
              ? (current.publishedAt ?? new Date())
              : current.publishedAt,
          blog: {
            update: {
              title: dto.title,
              content: dto.content,
              ...(dto.content !== undefined
                ? { excerpt: this.excerpt(dto.content) }
                : {}),
              coverImageUrl: dto.coverImageUrl,
              ...(dto.recipeIds !== undefined
                ? {
                    recipes: {
                      deleteMany: {},
                      create: this.recipeLinks(dto.recipeIds),
                    },
                  }
                : {}),
            },
          },
        },
        include: detailInclude(authorId),
      });
      return this.toDetail(row);
    });
  }

  async remove(id: string, authorId: string): Promise<void> {
    await this.write(async (tx) => {
      await this.lockOwned(tx, id, authorId);
      // The post owns its blog, recipe links and interactions; all cascade.
      await tx.post.delete({ where: { id, authorId, type: PostType.BLOG } });
    });
  }

  private async lockOwned(
    tx: Prisma.TransactionClient,
    id: string,
    authorId: string,
  ) {
    // Serialize edit/publish/delete so publication cannot validate an old
    // content value while another edit replaces it with an empty draft.
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM posts
      WHERE id = ${id}::uuid AND author_id = ${authorId}::uuid AND type = 'BLOG'
      FOR UPDATE
    `);
    if (rows.length === 0) throw new NotFoundException('Blog not found');
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

  private async validateRecipes(tx: Prisma.TransactionClient, ids?: string[]) {
    if (!ids?.length) return;
    const recipes = await tx.recipe.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
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

  private recipeLinks(ids: string[]) {
    return ids.map((recipeId, position) => ({ recipeId, position }));
  }

  private excerpt(content: string) {
    return Array.from(content.replace(/\s+/g, ' ').trim())
      .slice(0, 280)
      .join('');
  }

  private toDetail(
    row: Prisma.PostGetPayload<{ include: ReturnType<typeof detailInclude> }>,
  ): BlogDetailDto {
    if (!row.blog) throw new NotFoundException('Blog not found');
    return {
      ...this.posts.toResponse(row),
      content: row.blog.content,
      updatedAt: row.blog.updatedAt,
    };
  }

  private async write<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.prisma.$transaction(run);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025')
          throw new NotFoundException('Blog not found');
        if (error.code === 'P2003')
          throw new BadRequestException(
            'A linked recipe or account no longer exists',
          );
      }
      throw error;
    }
  }
}
