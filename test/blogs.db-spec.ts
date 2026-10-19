import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PostType, PrismaClient } from '@prisma/client';
import { MediaService } from '../src/media/media.service';
import { MuxService } from '../src/mux/mux.service';
import { PostSearchIndexService } from '../src/post-search/post-search-index.service';
import { PostSearchService } from '../src/post-search/post-search.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BlogsService } from '../src/posts/blogs.service';
import { PostInteractionsService } from '../src/posts/post-interactions.service';
import { PostsService } from '../src/posts/posts.service';

describe('Blog lifecycle with PostgreSQL', () => {
  const schema = `vedora_blog_test_${randomUUID().replaceAll('-', '')}`;
  let prisma: PrismaClient;
  let blogs: BlogsService;
  let posts: PostsService;
  let interactions: PostInteractionsService;
  let authorId: string;
  let otherId: string;
  let recipeIds: string[];

  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const db = prisma as PrismaService;
    // Blog posts have no attached videos; no external media operations occur.
    posts = new PostsService(
      db,
      {} as MediaService,
      {} as MuxService,
      {} as PostSearchIndexService,
      {} as PostSearchService,
    );
    blogs = new BlogsService(db, posts);
    interactions = new PostInteractionsService(db);
    const author = await prisma.user.create({
      data: {
        username: 'blog.author',
        fullName: 'Author',
        email: 'blog.author@example.test',
      },
    });
    const other = await prisma.user.create({
      data: {
        username: 'blog.other',
        fullName: 'Other',
        email: 'blog.other@example.test',
      },
    });
    authorId = author.id;
    otherId = other.id;
    recipeIds = [];
    for (const title of ['Đậu hũ', 'Canh rau']) {
      const recipe = await prisma.recipe.create({
        data: { title, servings: 2, steps: ['Nấu'] },
      });
      recipeIds.push(recipe.id);
    }
  });

  beforeEach(async () => {
    await prisma?.post.deleteMany();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
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
    expect(await prisma.post.count()).toBe(1);
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
    const short = await prisma.post.create({
      data: { authorId, type: 'POST', status: 'PUBLISHED', body: 'Short post' },
    });
    await expect(
      blogs.update(short.id, authorId, { title: 'Wrong type' }),
    ).rejects.toThrow('Blog not found');
    await expect(blogs.remove(short.id, authorId)).rejects.toThrow(
      'Blog not found',
    );
    expect(await prisma.post.count()).toBe(2);
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
    expect(saved.status === 'PUBLISHED' && saved.content.trim() === '').toBe(
      false,
    );
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
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogRecipe.count()).toBe(0);
    expect(await prisma.postComment.count()).toBe(0);
    expect(await prisma.postLike.count()).toBe(0);
    expect(await prisma.postBookmark.count()).toBe(0);
    expect(await prisma.recipe.count()).toBe(2);
    await expect(blogs.findOne(article.id, authorId)).rejects.toThrow(
      'Blog not found',
    );
  });

  it('removes only the recipe link when a catalog recipe is deleted', async () => {
    const recipe = await prisma.recipe.create({
      data: { title: 'Temporary', servings: 1, steps: [] },
    });
    const article = await blogs.create(authorId, {
      title: 'Keep blog',
      content: 'Instructions',
      recipeIds: [recipe.id],
    });
    await prisma.recipe.delete({ where: { id: recipe.id } });
    expect((await blogs.findOne(article.id, authorId)).blog?.recipes).toEqual(
      [],
    );
    expect(await prisma.blog.count()).toBe(1);
  });
});
