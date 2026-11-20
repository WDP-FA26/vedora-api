import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '../../../../src/auth-core/auth.types.js';
import type { CloudinaryService } from '../../../../src/cloudinary/cloudinary.service.js';
import {
  PostStatus,
  PostType,
  UserRole,
} from '../../../../src/mongo/models.js';
import type { BlogImagesService } from '../../../../src/posts/blogs/blog-images.service.js';
import { BlogsController } from '../../../../src/posts/blogs/blogs.controller.js';
import type { BlogsService } from '../../../../src/posts/blogs/blogs.service.js';
import type {
  BlogImageUploadDto,
  BlogVideoUploadDto,
} from '../../../../src/posts/dto/blog-image.dto.js';
import type { BlogDetailDto } from '../../../../src/posts/dto/blog.dto.js';
import type { PostPageDto } from '../../../../src/posts/dto/post-response.dto.js';
import type { PostsQueryService } from '../../../../src/posts/posts-query.service.js';

describe('BlogsController', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const blogId = '22222222-2222-4222-8222-222222222222';
  const authReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as AuthenticatedRequest;
  const anonReq = {} as OptionalAuthenticatedRequest;
  const optAuthReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as OptionalAuthenticatedRequest;

  let blogs: DeepMockProxy<BlogsService>;
  let postsQuery: DeepMockProxy<PostsQueryService>;
  let images: DeepMockProxy<BlogImagesService>;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let controller: BlogsController;

  beforeEach(() => {
    blogs = mockDeep<BlogsService>();
    postsQuery = mockDeep<PostsQueryService>();
    images = mockDeep<BlogImagesService>();
    cloudinary = mockDeep<CloudinaryService>();
    controller = new BlogsController(blogs, postsQuery, images, cloudinary);
  });

  it('delegates create, createImageUpload, and createVideoUpload', async () => {
    const detail = { id: blogId } as BlogDetailDto;
    const imgUpload = {
      url: 'https://cdn.example.com/a.jpg',
    } as BlogImageUploadDto;
    const vidUpload = {
      url: 'https://cdn.example.com/a.mp4',
    } as BlogVideoUploadDto;
    blogs.create.mockResolvedValue(detail);
    images.createUpload.mockResolvedValue(imgUpload);
    cloudinary.signBlogVideoUpload.mockReturnValue(vidUpload);

    await expect(
      controller.create(authReq, { title: 'Phở chay' }),
    ).resolves.toBe(detail);
    expect(blogs.create).toHaveBeenCalledWith(userId, { title: 'Phở chay' });

    await expect(
      controller.createImageUpload(authReq, {
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    ).resolves.toBe(imgUpload);
    expect(images.createUpload).toHaveBeenCalledWith(userId, {
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });

    expect(controller.createVideoUpload()).toBe(vidUpload);
    expect(cloudinary.signBlogVideoUpload).toHaveBeenCalledOnce();
  });

  it('list forwards type=BLOG and sets Cache-Control only for authenticated users', async () => {
    const page = { items: [], nextCursor: null } as PostPageDto;
    postsQuery.list.mockResolvedValue(page);
    const res = mockDeep<Response>();

    await expect(controller.list({ limit: 10 }, anonReq, res)).resolves.toBe(
      page,
    );
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(postsQuery.list).toHaveBeenCalledWith(
      { limit: 10, type: PostType.BLOG },
      undefined,
    );

    await expect(
      controller.list({ limit: 10, authorId: userId }, optAuthReq, res),
    ).resolves.toBe(page);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(postsQuery.list).toHaveBeenCalledWith(
      { limit: 10, authorId: userId, type: PostType.BLOG },
      userId,
    );
  });

  it('mine always sets Cache-Control and delegates to blogs.listMine', async () => {
    const page = { items: [], nextCursor: null } as PostPageDto;
    blogs.listMine.mockResolvedValue(page);
    const res = mockDeep<Response>();

    await expect(
      controller.mine({ limit: 20, status: PostStatus.DRAFT }, authReq, res),
    ).resolves.toBe(page);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(blogs.listMine).toHaveBeenCalledWith(userId, {
      limit: 20,
      status: PostStatus.DRAFT,
    });
  });

  it('findOne sets Cache-Control when authenticated and delegates update/remove', async () => {
    const detail = { id: blogId } as BlogDetailDto;
    blogs.findOne.mockResolvedValue(detail);
    blogs.update.mockResolvedValue(detail);
    blogs.remove.mockResolvedValue();
    const res = mockDeep<Response>();

    await expect(controller.findOne(blogId, anonReq, res)).resolves.toBe(
      detail,
    );
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(blogs.findOne).toHaveBeenCalledWith(blogId, undefined);

    await expect(controller.findOne(blogId, optAuthReq, res)).resolves.toBe(
      detail,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(blogs.findOne).toHaveBeenCalledWith(blogId, userId);

    await expect(
      controller.update(blogId, authReq, { title: 'Mới' }),
    ).resolves.toBe(detail);
    expect(blogs.update).toHaveBeenCalledWith(blogId, userId, { title: 'Mới' });

    await expect(controller.remove(blogId, authReq)).resolves.toBeUndefined();
    expect(blogs.remove).toHaveBeenCalledWith(blogId, userId);
  });
});
