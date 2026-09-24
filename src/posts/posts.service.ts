import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaStatus, PostStatus, Prisma } from '@prisma/client';
import { MediaService } from '../media/media.service';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';

const postInclude = {
  author: { select: { id: true, username: true, fullName: true } },
  media: { orderBy: { position: 'asc' } },
} satisfies Prisma.PostInclude;

type PostWithRelations = Prisma.PostGetPayload<{
  include: typeof postInclude;
}>;

const DEFAULT_PAGE_SIZE = 20;

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

    return this.toResponse(await this.load(id));
  }

  async list(query: ListPostsQueryDto): Promise<PostPageDto> {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;
    const posts = await this.prisma.post.findMany({
      where: {
        status: PostStatus.PUBLISHED,
        ...(query.authorId ? { authorId: query.authorId } : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: postInclude,
    });
    const page = posts.slice(0, take);
    return {
      items: page.map((post) => this.toResponse(post)),
      nextCursor: posts.length > take ? page[page.length - 1].id : null,
    };
  }

  async findOne(id: string, viewerId: string): Promise<PostResponseDto> {
    let post = await this.prisma.post.findUnique({
      where: { id },
      include: postInclude,
    });
    const isAuthor = post?.authorId === viewerId;
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
      post = await this.load(id);
    }
    return this.toResponse(post);
  }

  async remove(id: string, authorId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== authorId) {
      throw new ForbiddenException('Only the author can delete this post');
    }

    await this.prisma.$transaction([
      this.prisma.mediaAsset.deleteMany({ where: { postId: id } }),
      this.prisma.post.delete({ where: { id } }),
    ]);
    for (const media of post.media) {
      await this.mediaService.deleteFromMux(media);
    }
  }

  private load(id: string): Promise<PostWithRelations> {
    return this.prisma.post.findUniqueOrThrow({
      where: { id },
      include: postInclude,
    });
  }

  private toResponse(post: PostWithRelations): PostResponseDto {
    return {
      id: post.id,
      type: post.type,
      status: post.status,
      body: post.body,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      author: post.author,
      media: post.media.map((media) => this.mediaService.toResponse(media)),
    };
  }
}
