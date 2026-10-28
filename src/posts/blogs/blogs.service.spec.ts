import type { INestApplication } from '@nestjs/common';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createUser } from '../../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../test/mongo-test-db.js';
import { Post } from '../../mongo/models.js';
import { MongoModule } from '../../mongo/mongo.module.js';
import { MongoService } from '../../mongo/mongo.service.js';
import {
  StorageService,
  StorageTarget,
} from '../../storage/storage.service.js';
import { BlogsService } from './blogs.service.js';
import { PostsService } from '../posts.service.js';

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
        { provide: PostsService, useValue: mockDeep<PostsService>() },
        { provide: StorageService, useValue: mockDeep<StorageService>() },
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
    // Building the response is PostsService's job; this spec checks covers.
    const posts = mockDeep<PostsService>();
    posts.toResponses.mockResolvedValue([{}] as never);
    blogs = new BlogsService(
      db,
      posts,
      storage,
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

  const create = (coverImageUrl: string) =>
    blogs.create(authorId, { title: 'Phở chay', coverImageUrl });
  const stored = () => postsModel.find({}).exec();

  it.each([
    ['an https link', 'https://cdn.example.com/pho.jpg'],
    ['an image in blog storage', `${STORAGE}/blogs/user/ai/pho.png`],
  ])('accepts %s', async (_case, url) => {
    await create(url);

    expect(await stored()).toMatchObject([{ blog: { coverImageUrl: url } }]);
  });

  it.each([
    ['plain http elsewhere', 'http://cdn.example.com/pho.jpg'],
    ['https without a public host', 'https://localhost/pho.jpg'],
  ])('refuses %s before writing', async (_case, url) => {
    const error = await create(url).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidInputException);
    expect(error).toMatchObject({ code: 'BLOG_COVER_NOT_ALLOWED' });
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
