import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PostStatus, Prisma, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  CommentBodyDto,
  CommentPageDto,
  CommentResponseDto,
} from './dto/comment.dto';
import { PostRepostResponseDto } from './dto/post-interaction.dto';
import { PostLikeResponseDto } from './dto/post-like-response.dto';

const commentSelect = {
  id: true,
  postId: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: { id: true, username: true, fullName: true, avatarUrl: true },
  },
} satisfies Prisma.PostCommentSelect;

@Injectable()
export class PostInteractionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listComments(
    postId: string,
    query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    await this.requirePublishedPost(this.prisma, postId);
    if (query.cursor) {
      // A cursor from another post must never affect this post's pagination.
      const cursor = await this.prisma.postComment.findFirst({
        where: { id: query.cursor, postId },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Invalid comment cursor');
    }
    const rows = await this.prisma.postComment.findMany({
      where: { postId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: commentSelect,
    });
    return createCursorPaginatedResponse(rows, query.limit);
  }

  async createComment(
    postId: string,
    authorId: string,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requirePublishedPost(tx, postId);
        return tx.postComment.create({
          data: { postId, authorId, body: dto.body },
          select: commentSelect,
        });
      });
    } catch (error: unknown) {
      this.rethrowMissingRecord(error);
    }
  }

  async updateComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requirePublishedPost(tx, postId);
        const comment = await this.requireComment(tx, postId, commentId);
        if (comment.authorId !== actor.sub)
          throw new ForbiddenException('Only the author can edit this comment');
        return tx.postComment.update({
          where: { id: commentId, postId, authorId: actor.sub },
          data: { body: dto.body },
          select: commentSelect,
        });
      });
    } catch (error: unknown) {
      this.rethrowMissingRecord(error);
    }
  }

  async removeComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const post = await this.requirePublishedPost(tx, postId);
      const comment = await this.requireComment(tx, postId, commentId);
      if (
        comment.authorId !== actor.sub &&
        post.authorId !== actor.sub &&
        actor.role !== UserRole.ADMIN
      ) {
        throw new ForbiddenException('You cannot delete this comment');
      }
      // deleteMany also handles a concurrent deletion without a Prisma error.
      await tx.postComment.deleteMany({ where: { id: commentId, postId } });
    });
  }

  async setLike(
    postId: string,
    userId: string,
    isLiked: boolean,
  ): Promise<PostLikeResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requirePublishedPost(tx, postId);
        if (isLiked) {
          // The composite primary key and ON CONFLICT prevent duplicate likes,
          // including simultaneous retries from the same account.
          await tx.postLike.createMany({
            data: [{ postId, userId }],
            skipDuplicates: true,
          });
        } else {
          await tx.postLike.deleteMany({ where: { postId, userId } });
        }
        const likeCount = await tx.postLike.count({ where: { postId } });
        return { postId, isLiked, likeCount };
      });
    } catch (error: unknown) {
      this.rethrowMissingRecord(error);
    }
  }

  async setRepost(
    postId: string,
    userId: string,
    isReposted: boolean,
  ): Promise<PostRepostResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requirePublishedPost(tx, postId);
        if (isReposted) {
          await tx.postRepost.createMany({
            data: [{ postId, userId }],
            skipDuplicates: true,
          });
        } else {
          await tx.postRepost.deleteMany({ where: { postId, userId } });
        }
        const repostCount = await tx.postRepost.count({ where: { postId } });
        return { postId, isReposted, repostCount };
      });
    } catch (error: unknown) {
      this.rethrowMissingRecord(error);
    }
  }

  private async requirePublishedPost(
    db: Prisma.TransactionClient,
    postId: string,
  ) {
    const post = await db.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
      select: { id: true, authorId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  private async requireComment(
    db: Prisma.TransactionClient,
    postId: string,
    commentId: string,
  ) {
    const comment = await db.postComment.findFirst({
      where: { id: commentId, postId },
      select: { id: true, authorId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    return comment;
  }

  private rethrowMissingRecord(error: unknown): never {
    // Deleting an account/post between authorization and a write must not
    // expose a raw foreign-key or missing-row error to the client.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2003' || error.code === 'P2025')
    ) {
      throw new NotFoundException('Post or comment no longer exists');
    }
    throw error;
  }
}
