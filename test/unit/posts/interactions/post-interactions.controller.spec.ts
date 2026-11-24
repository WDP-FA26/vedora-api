import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import {
  PostReportReason,
  PostReportStatus,
  UserRole,
} from '@src/mongo/models.js';
import type {
  CommentPageDto,
  CommentResponseDto,
} from '@src/posts/dto/comment.dto.js';
import type {
  PostBookmarkResponseDto,
  PostReportDto,
  PostRepostResponseDto,
} from '@src/posts/dto/post-interaction.dto.js';
import type { PostLikeResponseDto } from '@src/posts/dto/post-like-response.dto.js';
import { PostInteractionsController } from '@src/posts/interactions/post-interactions.controller.js';
import type { PostInteractionsService } from '@src/posts/interactions/post-interactions.service.js';
import type { PostReportsService } from '@src/posts/interactions/post-reports.service.js';

describe('PostInteractionsController', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const postId = '22222222-2222-4222-8222-222222222222';
  const commentId = '33333333-3333-4333-8333-333333333333';
  const actor = { sub: userId, username: 'chef', role: UserRole.USER };
  const authReq = { user: actor } as AuthenticatedRequest;

  let interactions: DeepMockProxy<PostInteractionsService>;
  let reports: DeepMockProxy<PostReportsService>;
  let controller: PostInteractionsController;

  beforeEach(() => {
    interactions = mockDeep<PostInteractionsService>();
    reports = mockDeep<PostReportsService>();
    controller = new PostInteractionsController(interactions, reports);
  });

  it('delegates comment CRUD endpoints to PostInteractionsService', async () => {
    const page = { items: [], nextCursor: null } as CommentPageDto;
    const comment = { id: commentId } as CommentResponseDto;
    interactions.listComments.mockResolvedValue(page);
    interactions.createComment.mockResolvedValue(comment);
    interactions.updateComment.mockResolvedValue(comment);
    interactions.removeComment.mockResolvedValue();

    await expect(controller.listComments(postId, { limit: 20 })).resolves.toBe(
      page,
    );
    expect(interactions.listComments).toHaveBeenCalledWith(postId, {
      limit: 20,
    });

    await expect(
      controller.createComment(postId, authReq, { body: 'Ngon quá' }),
    ).resolves.toBe(comment);
    expect(interactions.createComment).toHaveBeenCalledWith(postId, userId, {
      body: 'Ngon quá',
    });

    await expect(
      controller.updateComment(postId, commentId, authReq, { body: 'Sửa lại' }),
    ).resolves.toBe(comment);
    expect(interactions.updateComment).toHaveBeenCalledWith(
      postId,
      commentId,
      actor,
      { body: 'Sửa lại' },
    );

    await expect(
      controller.removeComment(postId, commentId, authReq),
    ).resolves.toBeUndefined();
    expect(interactions.removeComment).toHaveBeenCalledWith(
      postId,
      commentId,
      actor,
    );
  });

  it('delegates like/unlike, repost/unrepost, bookmark/unbookmark', async () => {
    const likeRes = {
      postId,
      isLiked: true,
      likeCount: 1,
    } as PostLikeResponseDto;
    const unlikeRes = {
      postId,
      isLiked: false,
      likeCount: 0,
    } as PostLikeResponseDto;
    interactions.setLike
      .mockResolvedValueOnce(likeRes)
      .mockResolvedValueOnce(unlikeRes);

    await expect(controller.like(postId, authReq)).resolves.toBe(likeRes);
    await expect(controller.unlike(postId, authReq)).resolves.toBe(unlikeRes);
    expect(interactions.setLike).toHaveBeenNthCalledWith(
      1,
      postId,
      userId,
      true,
    );
    expect(interactions.setLike).toHaveBeenNthCalledWith(
      2,
      postId,
      userId,
      false,
    );

    const repostRes = {
      postId,
      isReposted: true,
      repostCount: 2,
    } as PostRepostResponseDto;
    const unrepostRes = {
      postId,
      isReposted: false,
      repostCount: 1,
    } as PostRepostResponseDto;
    interactions.setRepost
      .mockResolvedValueOnce(repostRes)
      .mockResolvedValueOnce(unrepostRes);

    await expect(controller.repost(postId, authReq)).resolves.toBe(repostRes);
    await expect(controller.unrepost(postId, authReq)).resolves.toBe(
      unrepostRes,
    );
    expect(interactions.setRepost).toHaveBeenNthCalledWith(
      1,
      postId,
      userId,
      true,
    );
    expect(interactions.setRepost).toHaveBeenNthCalledWith(
      2,
      postId,
      userId,
      false,
    );

    const bmRes = { postId, isBookmarked: true } as PostBookmarkResponseDto;
    const unbmRes = { postId, isBookmarked: false } as PostBookmarkResponseDto;
    interactions.setBookmark
      .mockResolvedValueOnce(bmRes)
      .mockResolvedValueOnce(unbmRes);

    await expect(controller.bookmark(postId, authReq)).resolves.toBe(bmRes);
    await expect(controller.unbookmark(postId, authReq)).resolves.toBe(unbmRes);
    expect(interactions.setBookmark).toHaveBeenNthCalledWith(
      1,
      postId,
      userId,
      true,
    );
    expect(interactions.setBookmark).toHaveBeenNthCalledWith(
      2,
      postId,
      userId,
      false,
    );
  });

  it('delegates report creation to PostReportsService', async () => {
    const report: PostReportDto = {
      id: commentId,
      postId,
      reason: PostReportReason.SPAM,
      details: 'spam',
      status: PostReportStatus.PENDING,
      createdAt: new Date(),
    };
    reports.create.mockResolvedValue(report);

    await expect(
      controller.report(postId, authReq, {
        reason: PostReportReason.SPAM,
        details: 'spam',
      }),
    ).resolves.toBe(report);
    expect(reports.create).toHaveBeenCalledWith(postId, userId, {
      reason: PostReportReason.SPAM,
      details: 'spam',
    });
  });
});
