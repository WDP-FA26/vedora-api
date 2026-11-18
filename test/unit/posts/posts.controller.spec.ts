import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '../../../src/auth-core/auth.types.js';
import { PostType, UserRole } from '../../../src/mongo/models.js';
import type {
  PostPageDto,
  PostResponseDto,
} from '../../../src/posts/dto/post-response.dto.js';
import type { PostViewsService } from '../../../src/posts/post-views.service.js';
import type { PostsQueryService } from '../../../src/posts/posts-query.service.js';
import { PostsController } from '../../../src/posts/posts.controller.js';
import type { PostsService } from '../../../src/posts/posts.service.js';

describe('PostsController', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const postId = '22222222-2222-4222-8222-222222222222';
  const authReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as AuthenticatedRequest;
  const anonReq = {} as OptionalAuthenticatedRequest;
  const optAuthReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as OptionalAuthenticatedRequest;

  let postsService: DeepMockProxy<PostsService>;
  let postsQuery: DeepMockProxy<PostsQueryService>;
  let views: DeepMockProxy<PostViewsService>;
  let controller: PostsController;

  beforeEach(() => {
    postsService = mockDeep<PostsService>();
    postsQuery = mockDeep<PostsQueryService>();
    views = mockDeep<PostViewsService>();
    controller = new PostsController(postsService, postsQuery, views);
  });

  it('delegates create to postsService.create', async () => {
    const post = { id: postId } as PostResponseDto;
    postsService.create.mockResolvedValue(post);
    const dto = { type: PostType.POST, body: 'Đậu hũ sốt cà' };

    await expect(controller.create(authReq, dto)).resolves.toBe(post);
    expect(postsService.create).toHaveBeenCalledWith(userId, dto);
  });

  it('records views with user id when authenticated and ip fallback when anonymous', () => {
    const reqWithIp = {
      user: { sub: userId, username: 'chef', role: UserRole.USER },
      ip: '203.0.113.10',
    } as OptionalAuthenticatedRequest & { ip?: string };
    controller.recordViews(reqWithIp, { postIds: [postId] });
    expect(views.record).toHaveBeenCalledWith(userId, [postId]);

    const anonWithIp = {
      ip: '203.0.113.10',
    } as OptionalAuthenticatedRequest & {
      ip?: string;
    };
    controller.recordViews(anonWithIp, { postIds: [postId] });
    expect(views.record).toHaveBeenCalledWith('ip:203.0.113.10', [postId]);

    const anonNoIp = {} as OptionalAuthenticatedRequest & { ip?: string };
    controller.recordViews(anonNoIp, { postIds: [postId] });
    expect(views.record).toHaveBeenCalledWith('ip:unknown', [postId]);
  });

  it('delegates list, search, feed, listBookmarks, listFollowing to postsQuery', async () => {
    const page = { items: [], nextCursor: null } as PostPageDto;
    postsQuery.list.mockResolvedValue(page);
    postsQuery.search.mockResolvedValue(page);
    postsQuery.feed.mockResolvedValue(page);
    postsQuery.listBookmarks.mockResolvedValue(page);
    postsQuery.listFollowing.mockResolvedValue(page);

    await expect(
      controller.list({ limit: 20, type: PostType.POST }, anonReq),
    ).resolves.toBe(page);
    expect(postsQuery.list).toHaveBeenCalledWith(
      { limit: 20, type: PostType.POST },
      undefined,
    );

    await expect(
      controller.search({ q: 'phở', limit: 10 }, optAuthReq),
    ).resolves.toBe(page);
    expect(postsQuery.search).toHaveBeenCalledWith(
      { q: 'phở', limit: 10 },
      userId,
    );

    await expect(controller.feed({ limit: 15 }, authReq)).resolves.toBe(page);
    expect(postsQuery.feed).toHaveBeenCalledWith({ limit: 15 }, userId);

    await expect(
      controller.listBookmarks({ limit: 20 }, authReq),
    ).resolves.toBe(page);
    expect(postsQuery.listBookmarks).toHaveBeenCalledWith(userId, {
      limit: 20,
    });

    await expect(
      controller.listFollowing({ limit: 20 }, authReq),
    ).resolves.toBe(page);
    expect(postsQuery.listFollowing).toHaveBeenCalledWith(userId, {
      limit: 20,
    });
  });

  it('delegates listReposts with the optional viewer', async () => {
    const page = { items: [], nextCursor: null } as PostPageDto;
    postsQuery.listReposts.mockResolvedValue(page);

    await expect(
      controller.listReposts(userId, { limit: 20 }, anonReq),
    ).resolves.toBe(page);
    expect(postsQuery.listReposts).toHaveBeenCalledWith(
      userId,
      { limit: 20 },
      undefined,
    );

    await expect(
      controller.listReposts(userId, { limit: 20 }, optAuthReq),
    ).resolves.toBe(page);
    expect(postsQuery.listReposts).toHaveBeenLastCalledWith(
      userId,
      { limit: 20 },
      optAuthReq.user?.sub,
    );
  });

  it('findOne sets Cache-Control only when authenticated', async () => {
    const post = { id: postId } as PostResponseDto;
    postsQuery.findOne.mockResolvedValue(post);
    const res = mockDeep<Response>();

    await expect(controller.findOne(anonReq, postId, res)).resolves.toBe(post);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(postsQuery.findOne).toHaveBeenCalledWith(postId, undefined);

    await expect(controller.findOne(optAuthReq, postId, res)).resolves.toBe(
      post,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(postsQuery.findOne).toHaveBeenCalledWith(postId, userId);
  });

  it('delegates update and remove to postsService', async () => {
    const post = { id: postId } as PostResponseDto;
    postsService.update.mockResolvedValue(post);
    postsService.remove.mockResolvedValue();

    await expect(
      controller.update(postId, authReq, { body: 'Cập nhật' }),
    ).resolves.toBe(post);
    expect(postsService.update).toHaveBeenCalledWith(postId, userId, {
      body: 'Cập nhật',
    });

    await expect(controller.remove(authReq, postId)).resolves.toBeUndefined();
    expect(postsService.remove).toHaveBeenCalledWith(postId, userId);
  });
});
