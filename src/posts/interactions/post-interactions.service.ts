import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import {
  afterCursor,
  createCursorPaginatedResponse,
  CursorPaginationQueryDto,
} from '../../common/pagination/index.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import {
  NotificationType,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  PostStatus,
  User,
  UserRole,
} from '../../mongo/models.js';
import {
  CommentBodyDto,
  CommentPageDto,
  CommentResponseDto,
} from '../dto/comment.dto.js';
import {
  PostBookmarkResponseDto,
  PostRepostResponseDto,
} from '../dto/post-interaction.dto.js';
import { PostLikeResponseDto } from '../dto/post-like-response.dto.js';

function toCommentDto(comment: PostComment, author: User): CommentResponseDto {
  return {
    id: comment.id,
    postId: comment.postId,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: {
      id: author.id,
      username: author.username,
      fullName: author.fullName,
      avatarUrl: author.avatarUrl,
    },
  };
}

@Injectable()
export class PostInteractionsService {
  constructor(
    private readonly notifications: NotificationsService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostRepost.name)
    private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async listComments(
    postId: string,
    query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    await this.requirePublishedPost(postId);
    const filter: Record<string, unknown> = { postId };
    if (query.cursor) {
      // A cursor from another post must never affect this post's pagination.
      const cursor = await this.comments
        .findOne({ ...filter, _id: query.cursor })
        .exec();
      if (!cursor) throw new BadRequestException('Invalid comment cursor');
      Object.assign(
        filter,
        afterCursor('createdAt', { value: cursor.createdAt, id: cursor.id }),
      );
    }
    const rows = await this.comments
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const page = createCursorPaginatedResponse(rows, query.limit);
    const authors = await this.users
      .find({
        _id: { $in: [...new Set(rows.map(({ authorId }) => authorId))] },
      })
      .exec();
    const authorById = new Map(authors.map((author) => [author.id, author]));
    return {
      ...page,
      items: page.items.flatMap((comment) => {
        const author = authorById.get(comment.authorId);
        return author ? [toCommentDto(comment, author)] : [];
      }),
    };
  }

  async createComment(
    postId: string,
    authorId: string,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    const post = await this.requirePublishedPost(postId);
    const comment = await this.comments.create({
      postId,
      authorId,
      body: dto.body,
    });
    await this.notifications.notify({
      recipientId: post.authorId,
      actorId: authorId,
      type: NotificationType.COMMENT,
      postId,
      commentId: comment.id,
    });
    return this.loadComment(comment.id);
  }

  async updateComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    await this.requirePublishedPost(postId);
    const comment = await this.requireComment(postId, commentId);
    if (comment.authorId !== actor.sub)
      throw new ForbiddenException('Only the author can edit this comment');
    const updated = await this.comments
      .findOneAndUpdate(
        { _id: commentId, postId, authorId: actor.sub },
        { $set: { body: dto.body } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) throw new NotFoundException('Comment not found');
    return this.loadComment(commentId);
  }

  async removeComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const post = await this.requirePublishedPost(postId);
    const comment = await this.requireComment(postId, commentId);
    if (
      comment.authorId !== actor.sub &&
      post.authorId !== actor.sub &&
      actor.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('You cannot delete this comment');
    }
    // A concurrent deletion simply deletes nothing.
    await this.comments.deleteOne({ _id: commentId, postId }).exec();
  }

  async setLike(
    postId: string,
    userId: string,
    isLiked: boolean,
  ): Promise<PostLikeResponseDto> {
    const post = await this.requirePublishedPost(postId);
    let created = false;
    if (isLiked) {
      try {
        await this.likes.create({ postId, userId });
        created = true;
      } catch (error) {
        // The unique (post, user) index: it is liked already.
        if (!isUniqueViolation(error)) throw error;
      }
    } else {
      await this.likes.deleteOne({ postId, userId }).exec();
    }
    const likeCount = await this.likes.countDocuments({ postId }).exec();
    if (created) {
      await this.notifications.notify({
        recipientId: post.authorId,
        actorId: userId,
        type: NotificationType.LIKE,
        postId,
      });
    }
    return { postId, isLiked, likeCount };
  }

  async setRepost(
    postId: string,
    userId: string,
    isReposted: boolean,
  ): Promise<PostRepostResponseDto> {
    const post = await this.requirePublishedPost(postId);
    let created = false;
    if (isReposted) {
      try {
        await this.reposts.create({ postId, userId });
        created = true;
      } catch (error) {
        // The unique (post, user) index: it is reposted already.
        if (!isUniqueViolation(error)) throw error;
      }
    } else {
      await this.reposts.deleteOne({ postId, userId }).exec();
    }
    const repostCount = await this.reposts.countDocuments({ postId }).exec();
    if (created) {
      await this.notifications.notify({
        recipientId: post.authorId,
        actorId: userId,
        type: NotificationType.REPOST,
        postId,
      });
    }
    return { postId, isReposted, repostCount };
  }

  async setBookmark(
    postId: string,
    userId: string,
    isBookmarked: boolean,
  ): Promise<PostBookmarkResponseDto> {
    if (isBookmarked) {
      await this.requirePublishedPost(postId);
      try {
        await this.bookmarks.create({ postId, userId });
      } catch (error) {
        // The unique (post, user) index: it is saved already.
        if (!isUniqueViolation(error)) throw error;
      }
    } else {
      await this.bookmarks.deleteOne({ postId, userId }).exec();
    }
    return { postId, isBookmarked };
  }

  private async loadComment(id: string): Promise<CommentResponseDto> {
    const comment = await this.comments.findOne({ _id: id }).exec();
    if (!comment) throw new NotFoundException('Comment not found');
    const author = await this.users.findOne({ _id: comment.authorId }).exec();
    if (!author) throw new NotFoundException('Comment not found');
    return toCommentDto(comment, author);
  }

  private async requirePublishedPost(postId: string) {
    const post = await this.posts
      .findOne({ _id: postId, status: PostStatus.PUBLISHED })
      .select('authorId')
      .exec();
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  private async requireComment(postId: string, commentId: string) {
    const comment = await this.comments
      .findOne({ _id: commentId, postId })
      .select('authorId')
      .exec();
    if (!comment) throw new NotFoundException('Comment not found');
    return comment;
  }
}
