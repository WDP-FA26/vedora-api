import { Injectable, NotFoundException } from '@nestjs/common';
import { MediaAsset, Prisma } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { CaptionService } from '../media/caption.service';
import { AdminMediaDto } from '../media/dto/media-response.dto';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { blogSummarySelect, toBlogSummary } from './blog-query';
import {
  AdminPostDetailDto,
  AdminPostDto,
  AdminPostsQueryDto,
} from './dto/admin-post.dto';

const adminPostInclude = {
  blog: { select: blogSummarySelect },
  author: {
    select: { id: true, username: true, fullName: true, avatarUrl: true },
  },
  media: { orderBy: { position: 'asc' } },
  _count: { select: { comments: true, likes: true, reposts: true } },
} satisfies Prisma.PostInclude;

type AdminPostRow = Prisma.PostGetPayload<{ include: typeof adminPostInclude }>;

/** Every post whatever its status, for the admin content page. */
@Injectable()
export class AdminPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaService: MediaService,
    private readonly captions: CaptionService,
  ) {}

  async findAll(
    query: AdminPostsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostDto>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.post.findMany({
          where,
          include: adminPostInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...getPaginationArgs(query),
        }),
        this.prisma.post.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return createPaginatedResponse(
      rows.map((row) => this.toDto(row)),
      totalItems,
      query,
    );
  }

  async findOne(id: string): Promise<AdminPostDetailDto> {
    const row = await this.prisma.post.findUnique({
      where: { id },
      include: adminPostInclude,
    });
    if (!row) throw new NotFoundException('Post not found');
    return {
      ...this.toDto(row),
      media: await Promise.all(
        row.media.map(async (media) => ({
          ...this.toMediaDto(media),
          captions: await this.captions.listTracks(media),
        })),
      ),
    };
  }

  private toDto(row: AdminPostRow): AdminPostDto {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      body: row.body,
      blog: toBlogSummary(row.blog ?? null),
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      author: row.author,
      media: row.media.map((media) => this.toMediaDto(media)),
      commentCount: row._count.comments,
      likeCount: row._count.likes,
      repostCount: row._count.reposts,
      viewCount: row.viewCount,
    };
  }

  private toMediaDto(media: MediaAsset): AdminMediaDto {
    return {
      ...this.mediaService.toResponse(media),
      captionStatus: media.captionStatus,
      captionLanguage: media.captionLanguage,
    };
  }
}
