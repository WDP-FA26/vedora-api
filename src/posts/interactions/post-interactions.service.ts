import { ContentModerationService } from '../../moderation/content-moderation.service.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { MongoService } from '../../mongo/mongo.service.js';
import { withUserLocks } from '../../mongo/with-user-locks.js';
import { assertAccountActive } from '../../auth-core/account-access.js';
import type { AuthenticatedUser } from '../../auth-core/auth.types.js';
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
import { AccessDeniedException } from '../../common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';

function toCommentDto(
  comment: PostComment,
  author: User,
  replyCount = 0,
  replyToAuthor: User | null = null,
): CommentResponseDto {
  return {
    id: comment.id,
    postId: comment.postId,
    parentId: comment.parentId ?? null,
    replyToId: comment.replyToId ?? null,
    replyToAuthor: replyToAuthor
      ? {
          id: replyToAuthor.id,
          username: replyToAuthor.username,
          fullName: replyToAuthor.fullName,
          avatarUrl: replyToAuthor.avatarUrl,
          isProfessional: replyToAuthor.isProfessional,
        }
      : null,
    replyCount,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: {
      id: author.id,
      username: author.username,
      fullName: author.fullName,
      avatarUrl: author.avatarUrl,
      isProfessional: author.isProfessional,
    },
  };
}

@Injectable()
export class PostInteractionsService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly contentModeration: ContentModerationService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostRepost.name)
    private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
  ) {}

  async listComments(
    postId: string,
    query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    await this.requirePublishedPost(postId);
    return this.commentPage({ postId, parentId: null }, query);
  }

  async getComment(
    postId: string,
    commentId: string,
  ): Promise<CommentResponseDto> {
    await this.requirePublishedPost(postId);
    const row = await this.requireComment(postId, commentId);
    const [result] = await this.hydrateComments([row]);
    if (!result)
      throw new ResourceNotFoundException('NOT_FOUND', 'Comment not found');
    return result;
  }

  async listReplies(
    postId: string,
    parentId: string,
    query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    await this.requirePublishedPost(postId);
    const parent = await this.requireComment(postId, parentId);
    if (parent.parentId)
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Load replies using the root comment ID',
      );
    return this.commentPage({ postId, parentId }, query);
  }

  private async commentPage(
    scope: { postId: string; parentId: string | null },
    query: CursorPaginationQueryDto,
  ): Promise<CommentPageDto> {
    const filter: Record<string, unknown> = { ...scope };
    if (query.cursor) {
      const cursor = await this.comments
        .findOne({ ...scope, _id: query.cursor })
        .exec();
      if (!cursor)
        throw new InvalidInputException(
          'BAD_REQUEST',
          'Invalid comment cursor',
        );
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
    return { ...page, items: await this.hydrateComments(page.items) };
  }

  async createComment(
    postId: string,
    authorId: string,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    await this.requirePublishedPost(postId);
    await this.contentModeration.requireAllowed([
      { kind: 'text', text: dto.body },
    ]);
    const result = await withUserLocks(
      this.mongo,
      [authorId],
      async (session) => {
        await this.requireActiveAuthor(authorId, session);
        const post = await this.beginCommentWrite(postId, session);
        const [created] = await this.comments.create(
          [{ postId, authorId, body: dto.body }],
          { session },
        );
        const [comment] = await this.hydrateComments([created], session);
        return { post, comment };
      },
    );
    await this.notifications.notify({
      recipientId: result.post.authorId,
      actorId: authorId,
      type: NotificationType.COMMENT,
      postId,
      commentId: result.comment.id,
    });
    return result.comment;
  }

  async createReply(
    postId: string,
    targetId: string,
    authorId: string,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    await this.requirePublishedPost(postId);
    await this.requireComment(postId, targetId);
    await this.contentModeration.requireAllowed([
      { kind: 'text', text: dto.body },
    ]);
    const result = await withUserLocks(
      this.mongo,
      [authorId],
      async (session) => {
        await this.requireActiveAuthor(authorId, session);
        const post = await this.beginCommentWrite(postId, session);
        const target = await this.requireComment(postId, targetId, session);
        const parentId = target.parentId ?? target.id;
        await this.requireComment(postId, parentId, session);
        // These writes conflict with deletion of the root or selected reply, including account cascades.
        await this.comments.updateMany(
          { _id: { $in: [...new Set([parentId, targetId])] }, postId },
          { $inc: { threadRevision: 1 } },
          { session, timestamps: false },
        );
        const [created] = await this.comments.create(
          [{ postId, authorId, body: dto.body, parentId, replyToId: targetId }],
          { session },
        );
        const [comment] = await this.hydrateComments([created], session);
        return { post, targetAuthorId: target.authorId, comment };
      },
    );
    if (result.targetAuthorId !== authorId)
      await this.notifications.notify({
        recipientId: result.targetAuthorId,
        actorId: authorId,
        type: NotificationType.COMMENT_REPLY,
        postId,
        commentId: result.comment.id,
      });
    if (
      result.post.authorId !== authorId &&
      result.post.authorId !== result.targetAuthorId
    )
      await this.notifications.notify({
        recipientId: result.post.authorId,
        actorId: authorId,
        type: NotificationType.COMMENT,
        postId,
        commentId: result.comment.id,
      });
    return result.comment;
  }

  async updateComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
    dto: CommentBodyDto,
  ): Promise<CommentResponseDto> {
    await this.requirePublishedPost(postId);
    const original = await this.requireComment(postId, commentId);
    if (original.authorId !== actor.sub)
      throw new AccessDeniedException(
        'FORBIDDEN',
        'Only the author can edit this comment',
      );
    await this.contentModeration.requireAllowed([
      { kind: 'text', text: dto.body },
    ]);
    return withUserLocks(this.mongo, [actor.sub], async (session) => {
      await this.requireActiveAuthor(actor.sub, session);
      await this.beginCommentWrite(postId, session);
      const updated = await this.comments
        .findOneAndUpdate(
          { _id: commentId, postId, authorId: actor.sub },
          { $set: { body: dto.body } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!updated)
        throw new ResourceNotFoundException('NOT_FOUND', 'Comment not found');
      const [comment] = await this.hydrateComments([updated], session);
      return comment;
    });
  }

  async removeComment(
    postId: string,
    commentId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await withUserLocks(this.mongo, [actor.sub], async (session) => {
      const currentActor = await this.requireActiveAuthor(actor.sub, session);
      const post = await this.beginCommentWrite(postId, session);
      const comment = await this.requireComment(postId, commentId, session);
      if (
        comment.authorId !== actor.sub &&
        post.authorId !== actor.sub &&
        currentActor.role !== UserRole.ADMIN
      )
        throw new AccessDeniedException(
          'FORBIDDEN',
          'You cannot delete this comment',
        );
      // The schema cascades root children and notifications and clears surviving reply-to pointers.
      await this.comments
        .deleteOne({ _id: commentId, postId }, { session })
        .exec();
    });
  }

  private async requireActiveAuthor(
    id: string,
    session: ClientSession,
  ): Promise<User> {
    const author = await this.users.findById(id).session(session).exec();
    if (!author)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Account no longer exists',
      );
    assertAccountActive(author.status);
    return author;
  }

  private async beginCommentWrite(
    postId: string,
    session: ClientSession,
  ): Promise<Post> {
    const post = await this.posts
      .findOneAndUpdate(
        { _id: postId, status: PostStatus.PUBLISHED },
        { $inc: { commentRevision: 1 } },
        { returnDocument: 'after', session, timestamps: false },
      )
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    return post;
  }

  private async hydrateComments(
    rows: PostComment[],
    session?: ClientSession,
  ): Promise<CommentResponseDto[]> {
    if (!rows.length) return [];
    const targets = await this.comments
      .find({
        _id: {
          $in: rows.flatMap((row) => (row.replyToId ? [row.replyToId] : [])),
        },
        postId: { $in: [...new Set(rows.map((row) => row.postId))] },
      })
      .session(session ?? null)
      .exec();
    const targetById = new Map(targets.map((row) => [row.id, row]));
    const authors = await this.users
      .find({
        _id: {
          $in: [...new Set([...rows, ...targets].map((row) => row.authorId))],
        },
      })
      .session(session ?? null)
      .exec();
    const authorById = new Map(authors.map((row) => [row.id, row]));
    const counts = await this.comments
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            parentId: {
              $in: rows.filter((row) => !row.parentId).map((row) => row.id),
            },
          },
        },
        { $group: { _id: '$parentId', count: { $sum: 1 } } },
      ])
      .session(session ?? null)
      .exec();
    const countById = new Map(counts.map((row) => [row._id, row.count]));
    return rows.flatMap((row) => {
      const author = authorById.get(row.authorId);
      if (!author) return [];
      const target = row.replyToId ? targetById.get(row.replyToId) : null;
      return [
        toCommentDto(
          row,
          author,
          countById.get(row.id) ?? 0,
          target ? (authorById.get(target.authorId) ?? null) : null,
        ),
      ];
    });
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
        if (!isUniqueViolation(error)) throw error;
      }
    } else {
      await this.bookmarks.deleteOne({ postId, userId }).exec();
    }
    return { postId, isBookmarked };
  }

  private async requirePublishedPost(postId: string) {
    const post = await this.posts
      .findOne({ _id: postId, status: PostStatus.PUBLISHED })
      .select('authorId')
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    return post;
  }

  private async requireComment(
    postId: string,
    commentId: string,
    session?: ClientSession,
  ) {
    const comment = await this.comments
      .findOne({ _id: commentId, postId })
      .session(session ?? null)
      .exec();
    if (!comment)
      throw new ResourceNotFoundException('NOT_FOUND', 'Comment not found');
    return comment;
  }
}
