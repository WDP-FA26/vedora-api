import type { INestApplication } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createUser } from '../../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../test/mongo-test-db';
import { Blog } from '../../mongo/models';
import { MongoModule } from '../../mongo/mongo.module';
import { MongoService } from '../../mongo/mongo.service';
import { StorageService, StorageTarget } from '../../storage/storage.service';
import { BlogsService } from './blogs.service';
import { PostsService } from '../posts.service';

const STORAGE = 'http://localhost:9000/vedora-blogs';

describe('BlogsService covers', () => {
  let app: INestApplication;
  let db: MongoService;
  let blogsModel: Model<Blog>;
  let storage: DeepMockProxy<StorageService>;
  let blogs: BlogsService;
  let authorId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('blogcovers'))],
      providers: [
        BlogsService,
        { provide: PostsService, useValue: mockDeep<PostsService>() },
        { provide: StorageService, useValue: mockDeep<StorageService>() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    blogsModel = app.get(getModelToken(Blog.name));
    authorId = (await createUser(db)).id;
  });
  beforeEach(() => {
    storage = mockDeep<StorageService>();
    storage.keyFromPublicUrl.mockImplementation((_target, url) =>
      url.startsWith(`${STORAGE}/`) ? url.slice(STORAGE.length + 1) : null,
    );
    // Building the response is PostsService's job; this spec checks covers.
    const posts = mockDeep<PostsService>();
    posts.toResponses.mockResolvedValue([{}] as never);
    blogs = new BlogsService(
      db,
      posts,
      storage,
      app.get(getModelToken('Post')),
      app.get(getModelToken('Blog')),
      app.get(getModelToken('BlogRecipe')),
      app.get(getModelToken('Recipe')),
    );
  });
  afterEach(async () => {
    await db.db.collection('blogs').deleteMany({});
    await db.db.collection('posts').deleteMany({});
    await db.db.collection('blog_recipes').deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  const create = (coverImageUrl: string) =>
    blogs.create(authorId, { title: 'Phở chay', coverImageUrl });
  const stored = () => blogsModel.find({}).exec();

  it.each([
    ['an https link', 'https://cdn.example.com/pho.jpg'],
    ['an image in blog storage', `${STORAGE}/blogs/user/ai/pho.png`],
  ])('accepts %s', async (_case, url) => {
    await create(url);

    expect(await stored()).toMatchObject([{ coverImageUrl: url }]);
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
    expect(await stored()).toEqual([]);
  });

  it('checks covers against the blogs bucket', async () => {
    await create(`${STORAGE}/blogs/user/pho.png`);

    expect(storage.keyFromPublicUrl).toHaveBeenCalledWith(
      StorageTarget.Blogs,
      `${STORAGE}/blogs/user/pho.png`,
    );
  });
});
