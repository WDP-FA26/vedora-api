import type { INestApplication } from '@nestjs/common';
import { InvalidInputException } from '../../../../src/common/exceptions/invalid-input.exception.js';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { ResourceNotFoundException } from '../../../../src/common/exceptions/resource-not-found.exception.js';
import { createPost, createRecipe, createUser } from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';
import { Post, PostStatus, PostType } from '../../../../src/mongo/models.js';
import type { PostResponseDto } from '../../../../src/posts/dto/post-response.dto.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../../src/storage/storage.service.js';
import { CloudinaryService } from '../../../../src/cloudinary/cloudinary.service.js';
import { BlogsService } from '../../../../src/posts/blogs/blogs.service.js';
import { PostsQueryService } from '../../../../src/posts/posts-query.service.js';
import { PostModerationService } from '../../../../src/media/post-moderation.service.js';

const STORAGE = 'http://localhost:9000/vedora-blogs';

describe('BlogsService covers', () => {
  let app: INestApplication;
  let db: MongoService;
  let postsModel: Model<Post>;
  let storage: DeepMockProxy<StorageService>;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let blogs: BlogsService;
  let authorId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('blogcovers'))],
      providers: [
        BlogsService,
        { provide: PostsQueryService, useValue: mockDeep<PostsQueryService>() },
        { provide: StorageService, useValue: mockDeep<StorageService>() },
        {
          provide: PostModerationService,
          useValue: mockDeep<PostModerationService>(),
        },
        {
          provide: CloudinaryService,
          useValue: mockDeep<CloudinaryService>(),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    postsModel = app.get(getModelToken(Post.name));
    authorId = (await createUser(db)).id;
  });
  beforeEach(() => {
    storage = mockDeep<StorageService>();
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${STORAGE}/`) ? url.slice(STORAGE.length + 1) : null,
    );
    cloudinary = mockDeep<CloudinaryService>();
    cloudinary.isBlogVideoUrl.mockImplementation((url) =>
      url.startsWith('https://res.cloudinary.com/demo/video/upload/vedora/blog-videos/'),
    );
    const posts = mockDeep<PostsQueryService>();
    posts.toResponses.mockResolvedValue([{}] as never);
    blogs = new BlogsService(
      db,
      posts,
      storage,
      mockDeep<PostModerationService>(),
      app.get(getModelToken('Post')),
      app.get(getModelToken('Recipe')),
      cloudinary,
    );
  });
  afterEach(async () => {
    await db.connection.collections.posts.deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  const image = (url: string) => `Mở bài.\n\n![Phở chay](${url})\n\nKết bài.`;
  const create = (content: string, coverImageUrl?: string) =>
    blogs.create(authorId, { title: 'Phở chay', content, coverImageUrl });
  const stored = () => postsModel.find({}).exec();

  it('uses the first image in the content in blog storage as the cover', async () => {
    const url = `${STORAGE}/blogs/user/ai/pho.png`;
    await create(image(url));

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: url } }]);
  });

  it('skips blog videos when picking the cover from content', async () => {
    const second = `${STORAGE}/blogs/user/second.jpg`;
    await create(
      [
        '![](https://res.cloudinary.com/demo/video/upload/vedora/blog-videos/clip.mp4)',
        `![](${second})`,
      ].join('\n\n'),
    );

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: second } }]);
  });

  it('ignores the coverImageUrl the client sends', async () => {
    await create('Không có ảnh.', `${STORAGE}/blogs/user/elsewhere.jpg`);

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: null } }]);
  });

  it.each([
    ['external https link', 'https://cdn.example.com/pho.jpg'],
    ['plain http elsewhere', 'http://cdn.example.com/pho.jpg'],
    ['https without a public host', 'https://localhost/pho.jpg'],
  ])('still refuses a sent cover that is %s, before writing', async (_case, url) => {
    const error = await create('Nội dung.', url).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InvalidInputException);
    expect(error).toMatchObject({ code: 'BLOG_COVER_NOT_ALLOWED' });
    expect(await stored()).toEqual([]);
  });

  it('follows the content when the first image is replaced', async () => {
    await create(image(`${STORAGE}/blogs/user/old.jpg`));
    const [{ id }] = await stored();

    await blogs.update(id, authorId, {
      content: image(`${STORAGE}/blogs/user/new.jpg`),
    });

    expect(await stored()).toMatchObject([
      { blog: { coverImageUrl: `${STORAGE}/blogs/user/new.jpg` } },
    ]);
  });

  it('repairs a stale cover on any edit, even one that keeps the content', async () => {
    const currentUrl = `${STORAGE}/blogs/user/current.jpg`;
    await create(image(currentUrl));
    const [{ id }] = await stored();
    await postsModel.updateOne(
      { _id: id },
      { $set: { 'blog.coverImageUrl': `${STORAGE}/blogs/user/gone.jpg` } },
    );

    await blogs.update(id, authorId, { title: 'Phở chay Hà Nội' });

    expect(await stored()).toMatchObject([
      { blog: { coverImageUrl: currentUrl } },
    ]);
  });

  it('rejects external media URLs in markdown content while allowing storage images, blog videos, and hyperlinks', async () => {
    await expect(
      blogs.create(authorId, {
        title: 'Ảnh ngoài',
        content: '![outside](https://cdn.example.com/pho.jpg)',
      }),
    ).rejects.toMatchObject({ code: 'BLOG_MEDIA_NOT_ALLOWED' });

    await expect(
      blogs.create(authorId, {
        title: 'Ảnh reference ngoài',
        content: '![outside][pic]\n\n[pic]: https://cdn.example.com/pho.jpg',
      }),
    ).rejects.toMatchObject({ code: 'BLOG_MEDIA_NOT_ALLOWED' });

    const validContent = [
      `![in storage](${STORAGE}/blogs/user/a.png)`,
      '![video](https://res.cloudinary.com/demo/video/upload/vedora/blog-videos/v.mp4)',
      '[source link](https://example.com/article)',
      '```\n![in code](https://cdn.example.com/code.png)\n```',
    ].join('\n');
    const created = await blogs.create(authorId, {
      title: 'Hợp lệ',
      content: validContent,
    });
    expect(created.content).toBe(validContent);

    await expect(
      blogs.update(created.id, authorId, {
        content: '![bad](https://evil.example/a.png)',
      }),
    ).rejects.toMatchObject({ code: 'BLOG_MEDIA_NOT_ALLOWED' });
  });

  it('checks covers against the blogs bucket', async () => {
    await create(image(`${STORAGE}/blogs/user/pho.png`));

    expect(storage.keyFromPublicUrl).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      `${STORAGE}/blogs/user/pho.png`,
    );
  });
});

describe('BlogsService lifecycle', () => {
  let app: INestApplication;
  let db: MongoService;
  let postsModel: Model<Post>;
  let postsQuery: DeepMockProxy<PostsQueryService>;
  let storage: DeepMockProxy<StorageService>;
  let postModeration: DeepMockProxy<PostModerationService>;
  let blogs: BlogsService;
  let authorId: string;
  let otherId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('blogslifecycle'))],
      providers: [
        BlogsService,
        { provide: PostsQueryService, useValue: mockDeep<PostsQueryService>() },
        { provide: StorageService, useValue: mockDeep<StorageService>() },
        {
          provide: PostModerationService,
          useValue: mockDeep<PostModerationService>(),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    postsModel = app.get(getModelToken(Post.name));
    authorId = (await createUser(db, { username: 'blog.author' })).id;
    otherId = (await createUser(db, { username: 'blog.other' })).id;
  });

  beforeEach(() => {
    postsQuery = mockDeep<PostsQueryService>();
    storage = mockDeep<StorageService>();
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${STORAGE}/`) ? url.slice(STORAGE.length + 1) : null,
    );
    postModeration = mockDeep<PostModerationService>();
    postsQuery.toResponses.mockImplementation((rows) =>
      Promise.resolve(
        rows.map(
          (row) =>
            ({
              id: row.id,
              type: row.type,
              status: row.status,
              body: row.body,
            }) as PostResponseDto,
        ),
      ),
    );
    postModeration.settle.mockResolvedValue(1);
    blogs = new BlogsService(
      db,
      postsQuery,
      storage,
      postModeration,
      app.get(getModelToken('Post')),
      app.get(getModelToken('Recipe')),
    );
  });

  afterEach(async () => {
    await Promise.all([
      db.connection.collections.posts.deleteMany({}),
      db.connection.collections.recipes.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates DRAFT blogs with truncated 280-char excerpt and rejects empty published blogs or missing recipes', async () => {
    const longContent = '  ' + 'a'.repeat(300) + '  ';
    const draft = await blogs.create(authorId, {
      title: 'Nháp đầu tiên',
      content: longContent,
    });
    expect(draft.status).toBe(PostStatus.DRAFT);
    expect(draft.content).toBe(longContent);
    const storedDraft = await postsModel.findOne({ _id: draft.id }).exec();
    expect(storedDraft?.blog?.excerpt).toHaveLength(280);
    expect(postModeration.settle).not.toHaveBeenCalled();

    await expect(
      blogs.create(authorId, {
        title: 'Xuất bản rỗng',
        content: '   ',
        status: PostStatus.PUBLISHED,
      }),
    ).rejects.toMatchObject({ code: 'BLOG_CONTENT_REQUIRED' });

    const recipe = await createRecipe(db, { title: 'Bún chay' });
    await expect(
      blogs.create(authorId, {
        title: 'Thiếu công thức',
        recipeIds: [recipe.id, 'missing-recipe'],
      }),
    ).rejects.toMatchObject({
      code: 'BLOG_RECIPE_NOT_FOUND',
      details: { recipeIds: ['missing-recipe'] },
    });

    const published = await blogs.create(authorId, {
      title: 'Bài công khai',
      content: 'Nội dung hợp lệ',
      status: PostStatus.PUBLISHED,
      recipeIds: [recipe.id],
    });
    expect(published.status).toBe(PostStatus.PROCESSING);
    expect(postModeration.settle).toHaveBeenCalledWith([published.id]);
  });

  it('findOne enforces draft privacy and ignores non-blog posts', async () => {
    const draft = await blogs.create(authorId, {
      title: 'Nháp riêng',
      content: 'Nội dung',
    });
    await expect(blogs.findOne(draft.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(blogs.findOne(draft.id, otherId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(blogs.findOne(draft.id, authorId)).resolves.toMatchObject({
      id: draft.id,
      content: 'Nội dung',
    });

    const published = await createPost(db, {
      authorId,
      type: PostType.BLOG,
      status: PostStatus.PUBLISHED,
      blog: {
        title: 'Công khai',
        coverImageUrl: null,
        content: 'Bài hay',
        excerpt: 'Bài hay',
        recipeIds: [],
      },
    });
    await expect(blogs.findOne(published.id)).resolves.toMatchObject({
      id: published.id,
      content: 'Bài hay',
    });

    const shortPost = await createPost(db, {
      authorId,
      type: PostType.POST,
      status: PostStatus.PUBLISHED,
      body: 'Short',
    });
    await expect(blogs.findOne(shortPost.id, authorId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('listMine filters by status and paginates with cursor', async () => {
    const b1 = await createPost(db, {
      authorId,
      type: PostType.BLOG,
      status: PostStatus.DRAFT,
      publishedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      blog: {
        title: 'B1',
        coverImageUrl: null,
        content: '',
        excerpt: '',
        recipeIds: [],
      },
    });
    const b2 = await createPost(db, {
      authorId,
      type: PostType.BLOG,
      status: PostStatus.DRAFT,
      publishedAt: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      blog: {
        title: 'B2',
        coverImageUrl: null,
        content: '',
        excerpt: '',
        recipeIds: [],
      },
    });
    await createPost(db, {
      authorId,
      type: PostType.BLOG,
      status: PostStatus.PUBLISHED,
      createdAt: new Date('2026-01-03T00:00:00Z'),
      blog: {
        title: 'B3',
        coverImageUrl: null,
        content: 'x',
        excerpt: 'x',
        recipeIds: [],
      },
    });

    const page1 = await blogs.listMine(authorId, {
      limit: 1,
      status: PostStatus.DRAFT,
    });
    expect(page1.items.map((i) => i.id)).toEqual([b2.id]);
    expect(page1.nextCursor).toBe(b2.id);

    const page2 = await blogs.listMine(authorId, {
      limit: 1,
      status: PostStatus.DRAFT,
      cursor: b2.id,
    });
    expect(page2.items.map((i) => i.id)).toEqual([b1.id]);
    expect(page2.nextCursor).toBeNull();

    await expect(
      blogs.listMine(authorId, { limit: 10, cursor: 'invalid-cursor' }),
    ).rejects.toBeInstanceOf(InvalidInputException);
  });

  it('updates blogs across status transitions, handles empty/non-owned errors, and skips re-moderation for recipe-only edits', async () => {
    const draft = await blogs.create(authorId, {
      title: 'Tiêu đề',
      content: 'Nội dung ban đầu',
    });

    await expect(blogs.update(draft.id, authorId, {})).rejects.toBeInstanceOf(
      InvalidInputException,
    );
    await expect(
      blogs.update(draft.id, otherId, { title: 'Hack' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);

    // Publish draft
    const publishing = await blogs.update(draft.id, authorId, {
      status: PostStatus.PUBLISHED,
      coverImageUrl: `${STORAGE}/blogs/user/img.jpg`,
    });
    expect(publishing.status).toBe(PostStatus.PROCESSING);
    expect(postModeration.settle).toHaveBeenCalledWith([draft.id]);

    // Update PENDING_REVIEW without explicit status -> keeps publishing (PROCESSING + settle)
    postModeration.settle.mockClear();
    await postsModel
      .updateOne(
        { _id: draft.id },
        { $set: { status: PostStatus.PENDING_REVIEW } },
      )
      .exec();
    const fromPending = await blogs.update(draft.id, authorId, {
      title: 'Sửa khi chờ duyệt',
    });
    expect(fromPending.status).toBe(PostStatus.PROCESSING);
    expect(postModeration.settle).toHaveBeenCalledWith([draft.id]);

    // Recipe-only edit on PUBLISHED blog -> stays PUBLISHED, no re-moderation
    postModeration.settle.mockClear();
    const recipe = await createRecipe(db, { title: 'Món mới' });
    await postsModel
      .updateOne(
        { _id: draft.id },
        { $set: { status: PostStatus.PUBLISHED, publishedAt: new Date() } },
      )
      .exec();
    const recipeOnly = await blogs.update(draft.id, authorId, {
      recipeIds: [recipe.id],
    });
    expect(recipeOnly.status).toBe(PostStatus.PUBLISHED);
    expect(postModeration.settle).not.toHaveBeenCalled();

    // Update REJECTED without status -> transitions to DRAFT
    await postsModel
      .updateOne({ _id: draft.id }, { $set: { status: PostStatus.REJECTED } })
      .exec();
    const fromRejected = await blogs.update(draft.id, authorId, {
      content: 'Đã sửa lại',
      coverImageUrl: null,
      recipeIds: [],
    });
    expect(fromRejected.status).toBe(PostStatus.DRAFT);

    // Return PUBLISHED to DRAFT explicitly
    await postsModel
      .updateOne({ _id: draft.id }, { $set: { status: PostStatus.PUBLISHED } })
      .exec();
    const toDraft = await blogs.update(draft.id, authorId, {
      status: PostStatus.DRAFT,
      content: '',
    });
    expect(toDraft.status).toBe(PostStatus.DRAFT);
  });

  it('removes owned blogs and rejects non-owner removal', async () => {
    const draft = await blogs.create(authorId, { title: 'Sắp xóa' });
    await expect(blogs.remove(draft.id, otherId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );

    await blogs.remove(draft.id, authorId);
    expect(await postsModel.findOne({ _id: draft.id }).exec()).toBeNull();
  });
});
