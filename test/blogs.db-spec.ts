import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mockDeep } from 'vitest-mock-extended';
import { MediaService } from '../src/media/media.service';
import { CloudinaryService } from '../src/cloudinary/cloudinary.service';
import { PostStatus, PostType } from '../src/mongo/models';
import { MongoModule } from '../src/mongo/mongo.module';
import { MongoService } from '../src/mongo/mongo.service';
import { deleteWithReferences } from '../src/mongo/relations';
import { PostFeedService } from '../src/posts/search/post-feed.service';
import { PostSearchIndexService } from '../src/posts/search/post-search-index.service';
import { PostSearchService } from '../src/posts/search/post-search.service';
import { BlogsService } from '../src/posts/blogs/blogs.service';
import { PostInteractionsService } from '../src/posts/interactions/post-interactions.service';
import { PostsService } from '../src/posts/posts.service';
import { PostRelationsService } from '../src/posts/post-relations.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { StorageService } from '../src/storage/storage.service';
import {
  createPost,
  createRecipe,
  createUser,
  deleteWithCascade,
} from './fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db';

describe('Blog lifecycle with MongoDB', () => {
  let app: INestApplication;
  let db: MongoService;
  let blogs: BlogsService;
  let posts: PostsService;
  let interactions: PostInteractionsService;
  let authorId: string;
  let otherId: string;
  let recipeIds: string[];

  const count = (collection: string) =>
    db.db.collection(collection).countDocuments();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('blog'))],
      providers: [
        PostsService,
        PostRelationsService,
        BlogsService,
        PostInteractionsService,
        { provide: MediaService, useValue: mockDeep<MediaService>() },
        {
          provide: CloudinaryService,
          useValue: { webhooksEnabled: true },
        },
        {
          provide: PostSearchIndexService,
          useValue: mockDeep<PostSearchIndexService>(),
        },
        { provide: PostSearchService, useValue: mockDeep<PostSearchService>() },
        { provide: PostFeedService, useValue: mockDeep<PostFeedService>() },
        {
          provide: StorageService,
          useValue: { keyFromPublicUrl: () => null },
        },
        {
          provide: NotificationsService,
          useValue: { notify: () => Promise.resolve() },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    posts = app.get(PostsService);
    blogs = app.get(BlogsService);
    interactions = app.get(PostInteractionsService);
    const author = await createUser(db, {
      username: 'blog.author',
      fullName: 'Author',
      email: 'blog.author@example.test',
    });
    const other = await createUser(db, {
      username: 'blog.other',
      fullName: 'Other',
      email: 'blog.other@example.test',
    });
    authorId = author.id;
    otherId = other.id;
    recipeIds = [];
    for (const title of ['Đậu hũ', 'Canh rau']) {
      const recipe = await createRecipe(db, { title, steps: ['Nấu'] });
      recipeIds.push(recipe.id);
    }
  });

  beforeEach(async () => {
    await db.withTransaction((session) =>
      deleteWithReferences(db.db, session, 'posts', {}),
    );
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('keeps a draft private and out of all public feeds until published', async () => {
    const draft = await blogs.create(authorId, { title: 'Món chay' });
    expect(draft.status).toBe('DRAFT');
    expect(draft.publishedAt).toBeNull();
    expect(draft.content).toBe('');
    await expect(blogs.findOne(draft.id)).rejects.toThrow('Blog not found');
    await expect(blogs.findOne(draft.id, otherId)).rejects.toThrow(
      'Blog not found',
    );
    await expect(posts.findOne(draft.id)).rejects.toThrow('Post not found');
    expect((await posts.list({ limit: 20 })).items).toHaveLength(0);
    expect(
      (await blogs.listMine(authorId, { limit: 20 })).items.map(({ id }) => id),
    ).toEqual([draft.id]);
    expect((await blogs.listMine(otherId, { limit: 20 })).items).toHaveLength(
      0,
    );
    const published = await blogs.update(draft.id, authorId, {
      content: '## Cách làm\nNấu rau.',
      status: 'PUBLISHED',
    });
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect((await blogs.findOne(draft.id)).content).toContain('Nấu rau.');
    const feed = await posts.list({ limit: 20, authorId, type: PostType.BLOG });
    expect(feed.items[0]).toMatchObject({
      id: draft.id,
      blog: { title: 'Món chay' },
    });
    expect(feed.items[0]).not.toHaveProperty('content');
    expect(feed.items[0].blog).not.toHaveProperty('content');
  });

  it('preserves omitted fields, replaces links in input order and clears the cover', async () => {
    const article = await blogs.create(authorId, {
      title: 'Nấu chay',
      content: 'Nội dung',
      coverImageUrl: 'https://example.com/cover.jpg',
      recipeIds,
    });
    const edited = await blogs.update(article.id, authorId, {
      title: 'Nấu chay mỗi ngày',
    });
    expect(edited.content).toBe('Nội dung');
    expect(edited.blog?.coverImageUrl).toBe('https://example.com/cover.jpg');
    expect(edited.blog?.recipes.map(({ id }) => id)).toEqual(recipeIds);
    const linked = await blogs.update(article.id, authorId, {
      recipeIds: [...recipeIds].reverse(),
      coverImageUrl: null,
    });
    expect(linked.blog?.recipes.map(({ id }) => id)).toEqual(
      [...recipeIds].reverse(),
    );
    expect(linked.blog?.coverImageUrl).toBeNull();
    const cleared = await blogs.update(article.id, authorId, { recipeIds: [] });
    expect(cleared.blog?.recipes).toEqual([]);
  });

  it('rolls back all edits when a linked recipe is missing', async () => {
    const draft = await blogs.create(authorId, {
      title: 'Original',
      content: 'Original content',
      recipeIds,
    });
    await expect(
      blogs.update(draft.id, authorId, {
        title: 'Changed',
        status: 'PUBLISHED',
        recipeIds: [randomUUID()],
      }),
    ).rejects.toThrow('Some linked recipes do not exist');
    const saved = await blogs.findOne(draft.id, authorId);
    expect(saved).toMatchObject({
      status: 'DRAFT',
      blog: { title: 'Original' },
    });
    expect(saved.blog?.recipes.map(({ id }) => id)).toEqual(recipeIds);
    await expect(
      blogs.create(authorId, { title: 'Bad link', recipeIds: [randomUUID()] }),
    ).rejects.toThrow();
    expect(await count('posts')).toBe(1);
  });

  it('rejects non-owner edits/deletes and wrong post types without modifying them', async () => {
    const draft = await blogs.create(authorId, {
      title: 'Private',
      content: 'Full content',
    });
    await expect(
      blogs.update(draft.id, otherId, { status: 'PUBLISHED' }),
    ).rejects.toThrow('Blog not found');
    await expect(blogs.remove(draft.id, otherId)).rejects.toThrow(
      'Blog not found',
    );
    const short = await createPost(db, { authorId, body: 'Short post' });
    await expect(
      blogs.update(short.id, authorId, { title: 'Wrong type' }),
    ).rejects.toThrow('Blog not found');
    await expect(blogs.remove(short.id, authorId)).rejects.toThrow(
      'Blog not found',
    );
    expect(await count('posts')).toBe(2);
  });

  it('supports existing comments, likes, bookmarks and author feed on a published blog', async () => {
    const article = await blogs.create(authorId, {
      title: 'Món chay',
      content: 'Cách làm',
      status: 'PUBLISHED',
    });
    const comment = await interactions.createComment(article.id, otherId, {
      body: 'Ngon!',
    });
    await interactions.setLike(article.id, otherId, true);
    await interactions.setLike(article.id, otherId, true);
    await interactions.setBookmark(article.id, otherId, true);
    const saved = await posts.listBookmarks(otherId, { limit: 20 });
    expect(saved.items[0]).toMatchObject({
      id: article.id,
      type: 'BLOG',
      isLiked: true,
      isBookmarked: true,
      likeCount: 1,
      commentCount: 1,
    });
    expect(comment.postId).toBe(article.id);
    expect((await posts.list({ limit: 20, authorId })).items).toHaveLength(1);
    expect(
      (await posts.list({ limit: 20, type: PostType.POST })).items,
    ).toHaveLength(0);
  });

  it('unpublishes without leaking through bookmarks or interaction endpoints, and keeps publication time on republish', async () => {
    const article = await blogs.create(authorId, {
      title: 'Món',
      content: 'Cách làm',
      status: 'PUBLISHED',
    });
    await interactions.setBookmark(article.id, otherId, true);
    await blogs.update(article.id, authorId, { status: 'DRAFT' });
    expect(
      (await posts.listBookmarks(otherId, { limit: 20 })).items,
    ).toHaveLength(0);
    await expect(
      interactions.createComment(article.id, otherId, { body: 'Hello' }),
    ).rejects.toThrow('Post not found');
    await expect(
      interactions.setLike(article.id, otherId, true),
    ).rejects.toThrow('Post not found');
    await expect(
      interactions.setBookmark(article.id, otherId, true),
    ).rejects.toThrow('Post not found');
    await expect(blogs.findOne(article.id)).rejects.toThrow('Blog not found');
    const republished = await blogs.update(article.id, authorId, {
      status: 'PUBLISHED',
    });
    expect(republished.publishedAt).toEqual(article.publishedAt);
  });

  it('serializes a concurrent publish and empty draft edit so empty content is never published', async () => {
    const article = await blogs.create(authorId, {
      title: 'Race',
      content: 'Valid content',
    });
    const results = await Promise.allSettled([
      blogs.update(article.id, authorId, { status: 'PUBLISHED' }),
      blogs.update(article.id, authorId, { content: '', status: 'DRAFT' }),
    ]);
    const saved = await blogs.findOne(article.id, authorId);
    expect(
      saved.status === PostStatus.PUBLISHED && saved.content.trim() === '',
    ).toBe(false);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    await expect(
      blogs.update(article.id, authorId, { status: 'PUBLISHED' }),
    ).rejects.toThrow('A published blog needs content');
  });

  it('paginates only the caller blogs and rejects cross-account cursors', async () => {
    const ids = [];
    for (let index = 0; index < 3; index++)
      ids.push((await blogs.create(authorId, { title: `Draft ${index}` })).id);
    const first = await blogs.listMine(authorId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const next = await blogs.listMine(authorId, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(next.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...next.items].map(({ id }) => id)),
    ).toEqual(new Set(ids));
    await expect(
      blogs.listMine(otherId, { limit: 2, cursor: first.nextCursor! }),
    ).rejects.toThrow('Invalid blog cursor');
  });

  it('deletes the article, links and interactions atomically and preserves catalog recipes', async () => {
    const article = await blogs.create(authorId, {
      title: 'Delete',
      content: 'Instructions',
      status: 'PUBLISHED',
      recipeIds,
    });
    await interactions.createComment(article.id, otherId, { body: 'Thanks' });
    await interactions.setLike(article.id, otherId, true);
    await interactions.setBookmark(article.id, otherId, true);
    await blogs.remove(article.id, authorId);
    expect(await count('blogs')).toBe(0);
    expect(await count('blog_recipes')).toBe(0);
    expect(await count('post_comments')).toBe(0);
    expect(await count('post_likes')).toBe(0);
    expect(await count('post_bookmarks')).toBe(0);
    expect(await count('recipes')).toBe(2);
    await expect(blogs.findOne(article.id, authorId)).rejects.toThrow(
      'Blog not found',
    );
  });

  it('removes only the recipe link when a catalog recipe is deleted', async () => {
    const recipe = await createRecipe(db, {
      title: 'Temporary',
      servings: 1,
      steps: [],
    });
    const article = await blogs.create(authorId, {
      title: 'Keep blog',
      content: 'Instructions',
      recipeIds: [recipe.id],
    });
    await deleteWithCascade(db, 'recipes', recipe.id);
    expect((await blogs.findOne(article.id, authorId)).blog?.recipes).toEqual(
      [],
    );
    expect(await count('blogs')).toBe(1);
  });
});
