import { BadRequestException } from '@nestjs/common';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { BlogsService } from './blogs.service';
import { PostsService } from './posts.service';

const AUTHOR_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const STORAGE = 'http://localhost:9000/vedora-blogs';

describe('BlogsService covers', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let storage: DeepMockProxy<StorageService>;
  let blogs: BlogsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.$transaction.mockResolvedValue({});
    storage = mockDeep<StorageService>();
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${STORAGE}/`) ? url.slice(STORAGE.length + 1) : null,
    );
    blogs = new BlogsService(prisma, mockDeep<PostsService>(), storage);
  });

  const create = (coverImageUrl: string) =>
    blogs.create(AUTHOR_ID, { title: 'Phở chay', coverImageUrl });

  it.each([
    ['an https link', 'https://cdn.example.com/pho.jpg'],
    ['an image in blog storage', `${STORAGE}/blogs/${AUTHOR_ID}/ai/pho.png`],
  ])('accepts %s', async (_case, url) => {
    await create(url);

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it.each([
    ['plain http elsewhere', 'http://cdn.example.com/pho.jpg'],
    ['https without a public host', 'https://localhost/pho.jpg'],
  ])('refuses %s before writing', async (_case, url) => {
    const error = await create(url).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'BLOG_COVER_NOT_ALLOWED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('checks covers against the blogs bucket', async () => {
    await create(`${STORAGE}/blogs/${AUTHOR_ID}/pho.png`);

    expect(storage.keyFromPublicUrl).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      `${STORAGE}/blogs/${AUTHOR_ID}/pho.png`,
    );
  });
});
