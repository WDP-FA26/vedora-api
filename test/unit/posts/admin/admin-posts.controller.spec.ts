import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../../src/auth-core/auth.types.js';
import type { PaginatedResponseDto } from '../../../../src/common/pagination/index.js';
import { PostStatus, UserRole } from '../../../../src/mongo/models.js';
import { AdminPostsController } from '../../../../src/posts/admin/admin-posts.controller.js';
import type { AdminPostsService } from '../../../../src/posts/admin/admin-posts.service.js';
import type { AdminPostDto } from '../../../../src/posts/dto/admin-post.dto.js';
import type { PostsService } from '../../../../src/posts/posts.service.js';

describe('AdminPostsController', () => {
  const adminId = '11111111-1111-4111-8111-111111111111';
  const postId = '22222222-2222-4222-8222-222222222222';
  const adminReq = {
    user: { sub: adminId, username: 'admin', role: UserRole.ADMIN },
  } as AuthenticatedRequest;

  let adminPosts: DeepMockProxy<AdminPostsService>;
  let posts: DeepMockProxy<PostsService>;
  let controller: AdminPostsController;

  beforeEach(() => {
    adminPosts = mockDeep<AdminPostsService>();
    posts = mockDeep<PostsService>();
    controller = new AdminPostsController(adminPosts, posts);
  });

  it('delegates findAll, findOne, moderate, and remove', async () => {
    const page = {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    } as PaginatedResponseDto<AdminPostDto>;
    const dto = { id: postId } as AdminPostDto;
    adminPosts.findAll.mockResolvedValue(page);
    adminPosts.findOne.mockResolvedValue(dto);
    adminPosts.moderate.mockResolvedValue(dto);
    posts.removeAsAdmin.mockResolvedValue();

    await expect(
      controller.findAll({ page: 1, limit: 20, status: PostStatus.PENDING_REVIEW }),
    ).resolves.toBe(page);
    expect(adminPosts.findAll).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      status: PostStatus.PENDING_REVIEW,
    });

    await expect(controller.findOne(postId)).resolves.toBe(dto);
    expect(adminPosts.findOne).toHaveBeenCalledWith(postId);

    await expect(
      controller.moderate(adminReq, postId, {
        decision: 'APPROVE',
        note: 'Clean recipe',
      }),
    ).resolves.toBe(dto);
    expect(adminPosts.moderate).toHaveBeenCalledWith(
      postId,
      adminId,
      'APPROVE',
      'Clean recipe',
    );

    await expect(controller.remove(postId)).resolves.toBeUndefined();
    expect(posts.removeAsAdmin).toHaveBeenCalledWith(postId);
  });
});
