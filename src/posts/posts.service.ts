import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaStatus, PostStatus, Prisma } from '@prisma/client';
import {
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination';
import { MediaService } from '../media/media.service';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { blogSummarySelect, toBlogSummary } from './blog-query';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';

export const postInclude = (viewerId?: string) =>
  ({
    blog: { select: blogSummarySelect },
    author: {
      select: { id: true, username: true, fullName: true, avatarUrl: true },
    },
    media: { orderBy: { position: 'asc' } },
    _count: { select: { comments: true, likes: true, reposts: true } },
    likes: {
      where: { userId: viewerId ?? { in: [] } },
      select: { userId: true },
      take: 1,
    },
    reposts: {
      where: { userId: viewerId ?? { in: [] } },
      select: { userId: true },
      take: 1,
    },
    bookmarks: {
      where: { userId: viewerId ?? { in: [] } },
      select: { userId: true },
      take: 1,
    },
  }) satisfies Prisma.PostInclude;

type PostWithRelations = Prisma.PostGetPayload<{
  include: ReturnType<typeof postInclude>;
}>;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaService: MediaService,
    private readonly mux: MuxService,
  ) {}

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

    const { id } = await this.prisma.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: { authorId, type: dto.type, body },
      });
      await this.mediaService.claimForPost(tx, authorId, post.id, mediaIds);
      return post;
    });
    await this.mediaService.settlePosts({ id });

    return this.toResponse(await this.load(id, authorId));
  }

  async list(
    query: ListPostsQueryDto,
    viewerId?: string,
  ): Promise<PostPageDto> {
    const take = query.limit;
    const posts = await this.snapshot(
      this.prisma.post.findMany({
        where: {
          status: PostStatus.PUBLISHED,
          ...(query.authorId ? { authorId: query.authorId } : {}),
          ...(query.type ? { type: query.type } : {}),
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: postInclude(viewerId),
      }),
    );
    const page = createCursorPaginatedResponse(posts, take);
    return {
      items: page.items.map((post) => this.toResponse(post)),
      nextCursor: page.nextCursor,
    };
  }

  /** The published posts a user saved, most recently saved first. */
  async listBookmarks(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PostPageDto> {
    const rows = await this.snapshot(
      this.prisma.postBookmark.findMany({
        where: { userId, post: { status: PostStatus.PUBLISHED } },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor
          ? {
              cursor: { postId_userId: { postId: query.cursor, userId } },
              skip: 1,
            }
          : {}),
        select: { post: { include: postInclude(userId) } },
      }),
    );
    const page = createCursorPaginatedResponse(
      rows.map(({ post }) => post),
      query.limit,
    );
    return {
      items: page.items.map((post) => this.toResponse(post)),
      nextCursor: page.nextCursor,
    };
  }

  async findOne(id: string, viewerId?: string): Promise<PostResponseDto> {
    let post = await this.snapshot(
      this.prisma.post.findUnique({
        where: { id },
        include: postInclude(viewerId),
      }),
    );
    const isAuthor = viewerId !== undefined && post?.authorId === viewerId;
    if (!post || (post.status !== PostStatus.PUBLISHED && !isAuthor)) {
      throw new NotFoundException('Post not found');
    }

    // Without webhooks, the author's polling is what moves the video along.
    if (post.status === PostStatus.PROCESSING && !this.mux.webhooksEnabled) {
      const pending = post.media.filter(
        (media) =>
          media.status === MediaStatus.WAITING_UPLOAD ||
          media.status === MediaStatus.PROCESSING,
      );
      for (const media of pending) {
        await this.mediaService.refresh(media);
      }
      await this.mediaService.settlePosts({ id });
      post = await this.load(id, viewerId);
    }
    return this.toResponse(post);
  }

  async remove(id: string, authorId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { authorId: true },
    });
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
    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    await this.destroy(id);
  }

  private async destroy(id: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findMany({
      where: { postId: id },
      select: { id: true },
    });
    await this.prisma.post.delete({ where: { id } });
    // The media rows were detached (`onDelete: SetNull`); remove them from
    // Mux the same way as discarded uploads, retried until Mux confirms.
    await this.mediaService.discard({
      id: { in: media.map((item) => item.id) },
    });
  }

  private load(id: string, viewerId?: string): Promise<PostWithRelations> {
    return this.snapshot(
      this.prisma.post.findUniqueOrThrow({
        where: { id },
        include: postInclude(viewerId),
      }),
    );
  }

  private async snapshot<T>(query: Prisma.PrismaPromise<T>): Promise<T> {
    // Prisma may load relations with several SQL statements. Keep visibility
    // and the blog summary in one snapshot during concurrent unpublication.
    const [result] = await this.prisma.$transaction([query], {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    return result;
  }

  toResponse(post: PostWithRelations): PostResponseDto {
    return {
      id: post.id,
      type: post.type,
      status: post.status,
      body: post.body,
      blog: toBlogSummary(post.blog ?? null),
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      author: post.author,
      media: post.media.map((media) => this.mediaService.toResponse(media)),
      commentCount: post._count.comments,
      likeCount: post._count.likes,
      isLiked: post.likes.length > 0,
      repostCount: post._count.reposts,
      isReposted: post.reposts.length > 0,
      isBookmarked: post.bookmarks.length > 0,
      viewCount: post.viewCount,
    };
  }
}
