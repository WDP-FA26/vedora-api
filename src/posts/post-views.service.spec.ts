import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPost, createUser } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { PostStatus, type Post, type Stored } from '../mongo/models';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import { PostViewsService } from './post-views.service';

const MINUTE = 60_000;

describe('PostViewsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostViewsService;
  let postA: string;
  let postB: string;

  const viewCount = async (id: string) => {
    const post = await db.db
      .collection<Stored<Post>>('posts')
      .findOne({ _id: id });
    return post?.viewCount as number;
  };
  const updatedAt = async (id: string) => {
    const post = await db.db
      .collection<Stored<Post>>('posts')
      .findOne({ _id: id });
    return post?.updatedAt as Date;
  };
  const setStatus = (id: string, status: PostStatus) =>
    db.db
      .collection<Stored<Post>>('posts')
      .updateOne({ _id: id }, { $set: { status } });

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
    await db.db
      .collection<Stored<Post>>('posts')
      .updateMany({}, { $set: { viewCount: 0 } });
    service = new PostViewsService(db);
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
    const collection = vi.spyOn(db.db, 'collection');
    await service.flush();
    expect(collection).not.toHaveBeenCalled();
  });

  it('keeps the counts for the next flush when the write fails', async () => {
    const posts = db.db.collection<Stored<Post>>('posts');
    vi.spyOn(posts, 'bulkWrite').mockRejectedValueOnce(new Error('down'));
    vi.spyOn(db.db, 'collection').mockReturnValue(posts as never);
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
