import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PostReportStatus, PostStatus, Prisma } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminPostReportDto,
  CreatePostReportDto,
  PostReportDto,
  PostReportsQueryDto,
  ReportDecision,
} from './dto/post-interaction.dto';

const author = {
  select: { id: true, username: true, fullName: true, avatarUrl: true },
} satisfies Prisma.UserDefaultArgs;

const reportSelect = {
  id: true,
  postId: true,
  reason: true,
  details: true,
  status: true,
  createdAt: true,
} satisfies Prisma.PostReportSelect;

const adminReportSelect = {
  ...reportSelect,
  reviewedAt: true,
  reporter: author,
  post: { select: { id: true, body: true, author } },
} satisfies Prisma.PostReportSelect;

@Injectable()
export class PostReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    postId: string,
    reporterId: string,
    dto: CreatePostReportDto,
  ): Promise<PostReportDto> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
      select: { authorId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId === reporterId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'OWN_POST',
        message: 'You cannot report your own post',
      });
    }
    try {
      return await this.prisma.postReport.create({
        data: {
          postId,
          reporterId,
          reason: dto.reason,
          details: dto.details || null,
        },
        select: reportSelect,
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'ALREADY_REPORTED',
          message: 'You have already reported this post',
        });
      }
      // The post was deleted between the check and the insert.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new NotFoundException('Post not found');
      }
      throw error;
    }
  }

  async findAll(
    query: PostReportsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostReportDto>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.postReport.findMany({
          where,
          select: adminReportSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...getPaginationArgs(query),
        }),
        this.prisma.postReport.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return createPaginatedResponse(rows, totalItems, query);
  }

  async review(
    id: string,
    reviewerId: string,
    status: ReportDecision,
  ): Promise<AdminPostReportDto> {
    // Conditional, so two admins can't both decide the same report.
    const { count } = await this.prisma.postReport.updateMany({
      where: { id, status: PostReportStatus.PENDING },
      data: { status, reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const report = await this.prisma.postReport.findUnique({
      where: { id },
      select: adminReportSelect,
    });
    if (!report) throw new NotFoundException('Report not found');
    if (count === 0) {
      throw new ConflictException('The report was already reviewed');
    }
    return report;
  }
}
