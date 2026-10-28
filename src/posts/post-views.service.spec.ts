import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPost, createUser } from '../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { Post, PostStatus } from '../mongo/models.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import { PostViewsService } from './post-views.service.js';

const MINUTE = 60_000;

describe('PostViewsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostViewsService;
  let postA: string;
  let postB: string;

  const posts = () => db.connection.model<Post>(Post.name);
  const viewCount = async (id: string) => {
    const post = await posts().findOne({ _id: id }).exec();
    return post?.viewCount as number;
  };
  const updatedAt = async (id: string) => {
    const post = await posts().findOne({ _id: id }).exec();
    return post?.updatedAt as Date;
  };
  const setStatus = (id: string, status: PostStatus) =>
    posts().updateOne({ _id: id }, { $set: { status } }).exec();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('views'))],
      providers: [PostViewsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    const author = await createUser(db);
    postA = (await createPost(db, { authorId: author.id })).id;
    postB = (await createPost(db, { authorId: author.id })).id;
  });
  beforeEach(async () => {
    await posts()
      .updateMany({}, { $set: { viewCount: 0 } })
      .exec();
    service = new PostViewsService(posts());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('writes nothing until a flush, then adds every post’s views', async () => {
    service.record('user-1', [postA, postB]);
    service.record('user-2', [postA]);
    expect(await viewCount(postA)).toBe(0);

    await service.flush();

    expect(await viewCount(postA)).toBe(2);
    expect(await viewCount(postB)).toBe(1);
  });

  it('counts a viewer once per post within the dedupe window', async () => {
    service.record('user-1', [postA, postA], 0);
    service.record('user-1', [postA], 10 * MINUTE);
    await service.flush();
    expect(await viewCount(postA)).toBe(1);

    service.record('user-1', [postA], 31 * MINUTE);
    await service.flush();
    expect(await viewCount(postA)).toBe(2);
  });

  it('adds to what is stored and leaves updatedAt alone', async () => {
    const before = {
      views: await viewCount(postA),
      at: await updatedAt(postA),
    };
    service.record('user-1', [postA]);
    await service.flush();
    expect(await viewCount(postA)).toBe(before.views + 1);
    expect(await updatedAt(postA)).toEqual(before.at);
  });

  it('ignores posts that are deleted or not published', async () => {
    await setStatus(postB, PostStatus.PROCESSING);
    service.record('user-1', [postB, 'f1a2d3e4-0000-4000-8000-0000000000ff']);
    await service.flush();
    expect(await viewCount(postB)).toBe(0);
    await setStatus(postB, PostStatus.PUBLISHED);
  });

  it('skips the database when nothing was viewed', async () => {
    const bulkWrite = vi.spyOn(posts(), 'bulkWrite');
    await service.flush();
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('keeps the counts for the next flush when the write fails', async () => {
    vi.spyOn(posts(), 'bulkWrite').mockRejectedValueOnce(new Error('down'));
    service.record('user-1', [postA]);
    await service.flush();
    expect(await viewCount(postA)).toBe(0);

    service.record('user-2', [postA]);
    await service.flush();
    expect(await viewCount(postA)).toBe(2);
  });

  it('flushes what is left on shutdown', async () => {
    service.record('user-1', [postA]);
    await service.onApplicationShutdown();
    expect(await viewCount(postA)).toBe(1);
  });
});
