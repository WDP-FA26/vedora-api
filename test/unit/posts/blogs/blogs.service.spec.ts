import type { INestApplication } from '@nestjs/common';
import { InvalidInputException } from '../../../../src/common/exceptions/invalid-input.exception.js';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createUser } from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';
import { Post } from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../../../src/storage/storage.service.js';
import { BlogsService } from '../../../../src/posts/blogs/blogs.service.js';
import { PostsQueryService } from '../../../../src/posts/posts-query.service.js';
import { PostModerationService } from '../../../../src/media/post-moderation.service.js';

const STORAGE = 'http://localhost:9000/vedora-blogs';

describe('BlogsService covers', () => {
  let app: INestApplication;
  let db: MongoService;
  let postsModel: Model<Post>;
  let storage: DeepMockProxy<StorageService>;
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
    const posts = mockDeep<PostsQueryService>();
    posts.toResponses.mockResolvedValue([{}] as never);
    blogs = new BlogsService(
      db,
      posts,
      storage,
      mockDeep<PostModerationService>(),
      app.get(getModelToken('Post')),
      app.get(getModelToken('Recipe')),
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

  it.each([
    ['an https link', 'https://cdn.example.com/pho.jpg'],
    ['an image in blog storage', `${STORAGE}/blogs/user/ai/pho.png`],
  ])('uses the first image in the content, %s, as the cover', async (_case, url) => {
    await create(image(url));

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: url } }]);
  });

  it('skips images that cannot be a cover and videos', async () => {
    await create(
      [
        '![](http://cdn.example.com/plain-http.jpg)',
        '![](https://res.cloudinary.com/demo/video/upload/clip.mp4)',
        '![](https://cdn.example.com/second.jpg)',
      ].join('\n\n'),
    );

    expect(await stored()).toMatchObject([
      { blog: { coverImageUrl: 'https://cdn.example.com/second.jpg' } },
    ]);
  });

  it('ignores the coverImageUrl the client sends', async () => {
    await create('Không có ảnh.', 'https://cdn.example.com/elsewhere.jpg');

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: null } }]);
  });

  it.each([
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
    await create(image('https://cdn.example.com/old.jpg'));
    const [{ id }] = await stored();

    await blogs.update(id, authorId, {
      content: image('https://cdn.example.com/new.jpg'),
    });

    expect(await stored()).toMatchObject([
      { blog: { coverImageUrl: 'https://cdn.example.com/new.jpg' } },
    ]);
  });

  it('repairs a stale cover on any edit, even one that keeps the content', async () => {
    await create(image('https://cdn.example.com/current.jpg'));
    const [{ id }] = await stored();
    await postsModel.updateOne(
      { _id: id },
      { $set: { 'blog.coverImageUrl': 'https://cdn.example.com/gone.jpg' } },
    );

    await blogs.update(id, authorId, { title: 'Phở chay Hà Nội' });

    expect(await stored()).toMatchObject([
      { blog: { coverImageUrl: 'https://cdn.example.com/current.jpg' } },
    ]);
  });

  it('checks covers against the blogs bucket', async () => {
    await create(image(`${STORAGE}/blogs/user/pho.png`));

    expect(storage.keyFromPublicUrl).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      `${STORAGE}/blogs/user/pho.png`,
    );
  });
});
