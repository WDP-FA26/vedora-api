import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { MediaService } from '../src/media/media.service';
import { MAX_BLOG_CONTENT, BlogDetailDto } from '../src/posts/dto/blog.dto';
import {
  PostStatus,
  PostType,
  type Recipe,
  type User,
} from '../src/mongo/models';
import { deleteWithReferences } from '../src/mongo/relations';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createPost, createRecipe, createUser } from './fixtures';

describe('Blogs (HTTP)', () => {
  let e2e: E2eApp;
  let author: User;
  let other: User;
  let token: string;
  let otherToken: string;
  let recipe: Recipe;
  const server = () => e2e.app.getHttpServer();
  const asAuthor = (req: request.Test) => req.auth(token, { type: 'bearer' });

  /** Creates a blog through the API, as the author. */
  const createBlog = async (fields: object = {}) =>
    (
      await asAuthor(request(server()).post('/api/v1/blogs'))
        .send({
          title: 'Đậu hũ sốt cà',
          content: '## Cách làm\nNấu đậu hũ với cà chua.',
          recipeIds: [recipe.id],
          ...fields,
        })
        .expect(201)
    ).body as BlogDetailDto;

  beforeAll(async () => {
    e2e = await createE2eApp('blogs_e2e');
    author = await createUser(e2e.mongo, { username: 'chef' });
    other = await createUser(e2e.mongo, { username: 'other.chef' });
    [token, otherToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(other),
    ]);
    recipe = await createRecipe(e2e.mongo, { title: 'Đậu hũ' });
  });
  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      deleteWithReferences(e2e.mongo.db, session, 'posts', {
        authorId: author.id,
      }),
    );
  });
  afterAll(async () => {
    await e2e.close();
  });

  it.each(['post', 'patch', 'delete'] as const)(
    'requires login to %s a blog',
    async (method) => {
      await request(server())
        [method](`/api/v1/blogs${method === 'post' ? '' : `/${randomUUID()}`}`)
        .send({ title: 'Món chay' })
        .expect(401);
      expect(await e2e.mongo.db.collection('posts').countDocuments()).toBe(0);
    },
  );

  it('creates a trimmed title and defaults to a private draft', async () => {
    const response = await asAuthor(request(server()).post('/api/v1/blogs'))
      .send({ title: '  Đậu hũ sốt cà  ' })
      .expect(201);
    expect(response.body).toMatchObject({
      status: 'DRAFT',
      publishedAt: null,
      blog: { title: 'Đậu hũ sốt cà' },
      content: '',
    });
  });

  it.each([
    { title: '' },
    { title: '   ' },
    { title: null },
    { title: 'a'.repeat(151) },
    { content: null },
    { content: 'a'.repeat(MAX_BLOG_CONTENT + 1) },
    { status: 'PROCESSING' },
    { status: null },
    { recipeIds: null },
    {
      recipeIds: [
        'd1a2d3e4-0000-4000-8000-000000000001',
        'd1a2d3e4-0000-4000-8000-000000000001',
      ],
    },
    { recipeIds: ['bad'] },
    { coverImageUrl: 'http://example.com/a.jpg' },
    { authorId: randomUUID() },
  ])('rejects invalid blog fields: %j', async (fields) => {
    await asAuthor(request(server()).post('/api/v1/blogs'))
      .send({ title: 'Món chay', ...fields })
      .expect(400);
    expect(await e2e.mongo.db.collection('posts').countDocuments()).toBe(0);
  });

  it('rejects publishing without content and reports missing recipes', async () => {
    const empty = await asAuthor(request(server()).post('/api/v1/blogs'))
      .send({ title: 'Món', status: 'PUBLISHED', content: '  ' })
      .expect(400);
    expect((empty.body as { code: string }).code).toBe('BLOG_CONTENT_REQUIRED');
    const missingId = randomUUID();
    const missing = await asAuthor(request(server()).post('/api/v1/blogs'))
      .send({ title: 'Món', recipeIds: [missingId] })
      .expect(400);
    expect(missing.body).toMatchObject({
      code: 'BLOG_RECIPE_NOT_FOUND',
      recipeIds: [missingId],
    });
    expect(await e2e.mongo.db.collection('posts').countDocuments()).toBe(0);
  });

  it('accepts long UTF-8 articles beyond the default JSON parser size', async () => {
    const content = '菜'.repeat(MAX_BLOG_CONTENT);
    const blog = await createBlog({ title: 'Long article', content });
    expect(blog.content).toBe(content);
  });

  it('preserves the exact request bytes for signed Cloudinary notifications', async () => {
    const handle = vi
      .spyOn(e2e.app.get(MediaService), 'handleNotification')
      .mockResolvedValue();
    const payload = '{ "notification_type": "eager",  "public_id": "x" }';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHash('sha1')
      .update(payload + timestamp + 'e2e-api-secret')
      .digest('hex');
    try {
      await request(server())
        .post('/api/v1/webhooks/cloudinary')
        .set('Content-Type', 'application/json')
        .set('x-cld-timestamp', timestamp)
        .set('x-cld-signature', signature)
        .send(payload)
        .expect(204);
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ notification_type: 'eager' }),
      );
    } finally {
      handle.mockRestore();
    }
  });

  it('hides drafts from guests and other users on both detail routes', async () => {
    const draft = await createBlog();
    for (const path of ['blogs', 'posts']) {
      await request(server()).get(`/api/v1/${path}/${draft.id}`).expect(404);
      await request(server())
        .get(`/api/v1/${path}/${draft.id}`)
        .auth(otherToken, { type: 'bearer' })
        .expect(404);
    }
  });

  it('lets the author read draft source without shared caching', async () => {
    const draft = await createBlog();
    const response = await asAuthor(
      request(server()).get(`/api/v1/blogs/${draft.id}`),
    ).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      content: '## Cách làm\nNấu đậu hũ với cà chua.',
      blog: { recipes: [{ id: recipe.id }] },
    });
    expect(response.body).not.toHaveProperty('authorId');
    expect((response.body as BlogDetailDto).blog).not.toHaveProperty('content');
  });

  it('serves published source publicly and rejects invalid supplied tokens', async () => {
    const published = await createBlog({ status: 'PUBLISHED' });
    await request(server()).get(`/api/v1/blogs/${published.id}`).expect(200);
    await request(server())
      .get(`/api/v1/blogs/${published.id}`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(server()).get('/api/v1/blogs/bad-id').expect(400);
    const plain = await createPost(e2e.mongo, {
      authorId: author.id,
      type: PostType.POST,
      status: PostStatus.PUBLISHED,
      viewCount: 0,
    });
    await request(server()).get(`/api/v1/blogs/${plain.id}`).expect(404);
  });

  it('limits public lists to published blogs and allows a feed type filter', async () => {
    const published = await createBlog({ status: 'PUBLISHED' });
    await createBlog({ title: 'Draft' });
    const blogs = await request(server())
      .get(`/api/v1/blogs?authorId=${author.id}`)
      .expect(200);
    expect(
      (blogs.body as { items: { id: string }[] }).items.map(({ id }) => id),
    ).toEqual([published.id]);
    const feed = await request(server())
      .get('/api/v1/posts?type=BLOG')
      .expect(200);
    expect(
      (feed.body as { items: { id: string }[] }).items.map(({ id }) => id),
    ).toEqual([published.id]);
    await request(server()).get('/api/v1/posts?type=INVALID').expect(400);
  });

  it('lists only the caller drafts and validates draft-list cursors', async () => {
    await request(server()).get('/api/v1/blogs/mine').expect(401);
    const draft = await createBlog();
    await createBlog({ status: 'PUBLISHED' });
    const response = await asAuthor(
      request(server()).get('/api/v1/blogs/mine?status=DRAFT'),
    ).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(
      (response.body as { items: { id: string }[] }).items.map(({ id }) => id),
    ).toEqual([draft.id]);
    await asAuthor(
      request(server()).get(`/api/v1/blogs/mine?cursor=${randomUUID()}`),
    ).expect(400);
  });

  it('supports partial edit, clearing a cover and replacing recipe links', async () => {
    const blog = await createBlog({
      coverImageUrl: 'https://example.com/a.jpg',
    });
    expect(blog.blog?.recipes).toHaveLength(1);
    const edited = await asAuthor(
      request(server()).patch(`/api/v1/blogs/${blog.id}`),
    )
      .send({ coverImageUrl: null, recipeIds: [] })
      .expect(200);
    expect(edited.body).toMatchObject({
      status: 'DRAFT',
      content: blog.content,
      blog: { coverImageUrl: null, recipes: [] },
    });
    await asAuthor(request(server()).patch(`/api/v1/blogs/${blog.id}`))
      .send({ content: null })
      .expect(400);
    await asAuthor(request(server()).patch(`/api/v1/blogs/${blog.id}`))
      .send({})
      .expect(400);
  });

  it('publishes a draft and prevents another author from editing or deleting it', async () => {
    const draft = await createBlog();
    const published = await asAuthor(
      request(server()).patch(`/api/v1/blogs/${draft.id}`),
    )
      .send({ status: 'PUBLISHED' })
      .expect(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED' });
    expect((published.body as BlogDetailDto).publishedAt).toBeTruthy();
    await request(server())
      .patch(`/api/v1/blogs/${draft.id}`)
      .auth(otherToken, { type: 'bearer' })
      .send({ title: 'Other' })
      .expect(404);
    await request(server())
      .delete(`/api/v1/blogs/${draft.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(404);
    expect(await e2e.mongo.db.collection('blogs').countDocuments()).toBe(1);
  });

  it('blocks draft comments, likes and bookmarks through existing endpoints', async () => {
    const draft = await createBlog();
    await asAuthor(request(server()).post(`/api/v1/posts/${draft.id}/comments`))
      .send({ body: 'Ngon!' })
      .expect(404);
    for (const interaction of ['like', 'bookmark']) {
      await asAuthor(
        request(server()).put(`/api/v1/posts/${draft.id}/${interaction}`),
      ).expect(404);
    }
    expect(
      await e2e.mongo.db.collection('post_comments').countDocuments(),
    ).toBe(0);
    expect(await e2e.mongo.db.collection('post_likes').countDocuments()).toBe(
      0,
    );
    expect(
      await e2e.mongo.db.collection('post_bookmarks').countDocuments(),
    ).toBe(0);
  });
});
