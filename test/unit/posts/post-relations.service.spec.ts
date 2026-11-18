import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import {
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  PostStatus,
  PostType,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { PostRelationsService } from '../../../src/posts/post-relations.service.js';
import {
  createMedia,
  createPost,
  createRecipe,
  createUser,
} from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('PostRelationsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostRelationsService;
  let comments: Model<PostComment>;
  let likes: Model<PostLike>;
  let reposts: Model<PostRepost>;
  let bookmarks: Model<PostBookmark>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postrelations'))],
      providers: [PostRelationsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostRelationsService);
    comments = app.get(getModelToken(PostComment.name));
    likes = app.get(getModelToken(PostLike.name));
    reposts = app.get(getModelToken(PostRepost.name));
    bookmarks = app.get(getModelToken(PostBookmark.name));
  });

  afterEach(async () => {
    await Promise.all(
      Object.values(db.connection.collections).map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('returns an empty map for empty input', async () => {
    const map = await service.hydrate([]);
    expect(map.size).toBe(0);
  });

  it('hydrates author, ordered media, counts, viewer flags, and blog recipe summaries', async () => {
    const author = await createUser(db, {
      username: 'chef.an',
      fullName: 'Chef An',
      isProfessional: true,
    });
    const viewer = await createUser(db, { username: 'viewer.binh' });
    const recipe1 = await createRecipe(db, {
      title: 'Phở chay',
      imageUrl: 'https://cdn.example.com/pho.jpg',
    });
    const recipe2 = await createRecipe(db, {
      title: 'Gỏi cuốn',
      imageUrl: null,
    });

    const shortPost = await createPost(db, {
      authorId: author.id,
      type: PostType.POST,
      status: PostStatus.PUBLISHED,
      body: 'Món ngon',
    });
    const blogPost = await createPost(db, {
      authorId: author.id,
      type: PostType.BLOG,
      status: PostStatus.PUBLISHED,
      blog: {
        title: 'Blog Phở',
        coverImageUrl: 'https://cdn.example.com/cover.jpg',
        content: 'Nội dung',
        excerpt: 'Nội dung',
        recipeIds: [recipe2.id, 'missing-recipe-id', recipe1.id],
      },
    });
    const blogNoRecipes = await createPost(db, {
      authorId: author.id,
      type: PostType.BLOG,
      status: PostStatus.PUBLISHED,
      blog: {
        title: 'Blog Không Món',
        coverImageUrl: null,
        content: 'Nội dung',
        excerpt: 'Nội dung',
        recipeIds: [],
      },
    });
    const orphanPost = await createPost(db, {
      authorId: 'missing-author-id',
      body: 'Orphan',
    });

    await createMedia(db, { postId: shortPost.id, position: 1 });
    await createMedia(db, { postId: shortPost.id, position: 0 });
    await comments.create({
      postId: shortPost.id,
      authorId: viewer.id,
      body: 'Ngon lắm',
    });
    await likes.create({ postId: shortPost.id, userId: viewer.id });
    await reposts.create({ postId: shortPost.id, userId: viewer.id });
    await bookmarks.create({ postId: blogPost.id, userId: viewer.id });

    const hydratedWithViewer = await service.hydrate(
      [shortPost, blogPost, blogNoRecipes, orphanPost],
      viewer.id,
    );

    expect(hydratedWithViewer.has(orphanPost.id)).toBe(false);

    const shortRel = hydratedWithViewer.get(shortPost.id);
    expect(shortRel).toMatchObject({
      author: {
        id: author.id,
        username: 'chef.an',
        fullName: 'Chef An',
        isProfessional: true,
      },
      blog: null,
      commentCount: 1,
      likeCount: 1,
      repostCount: 1,
      isLiked: true,
      isReposted: true,
      isBookmarked: false,
    });
    expect(shortRel?.media.map((m) => m.position)).toEqual([0, 1]);

    const blogRel = hydratedWithViewer.get(blogPost.id);
    expect(blogRel?.isBookmarked).toBe(true);
    expect(blogRel?.blog).toEqual({
      title: 'Blog Phở',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      excerpt: 'Nội dung',
      recipes: [
        { id: recipe2.id, title: 'Gỏi cuốn', imageUrl: null },
        {
          id: recipe1.id,
          title: 'Phở chay',
          imageUrl: 'https://cdn.example.com/pho.jpg',
        },
      ],
    });

    expect(hydratedWithViewer.get(blogNoRecipes.id)?.blog?.recipes).toEqual([]);

    const hydratedAnon = await service.hydrate([shortPost]);
    expect(hydratedAnon.get(shortPost.id)).toMatchObject({
      isLiked: false,
      isReposted: false,
      isBookmarked: false,
    });
  });
});
