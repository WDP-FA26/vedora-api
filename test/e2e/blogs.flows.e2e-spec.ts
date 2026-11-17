import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  type Post,
  PostStatus,
  PostType,
  type User,
  UserRole,
} from '../../src/mongo/models.js';
import {
  StorageService,
  StorageTarget,
} from '../../src/storage/storage.service.js';
import {
  BORDERLINE_MARKER,
  createE2eApp,
  type E2eApp,
} from '../support/e2e-app.js';
import { createPost, createUser } from '../support/fixtures.js';

interface BlogBody {
  id: string;
  status: PostStatus;
  publishedAt: string | null;
  content: string;
  blog: { title: string; excerpt: string; coverImageUrl: string | null };
}

interface ErrorBody {
  statusCode: number;
  code: string;
}

/**
 * Blog lifecycle DRAFT → PROCESSING → PUBLISHED / PENDING_REVIEW / REJECTED,
 * validation edges and the blog AI assistant guard rails
 * (docs/docs-for-FE/blogs.md, content-moderation.md, blog-ai-assistant.md).
 */
describe('Blog flows (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let authorToken: string;
  let strangerToken: string;
  let adminToken: string;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  beforeAll(async () => {
    e2e = await createE2eApp('blogs_flows_e2e');
    author = await createUser(e2e.mongo);
    stranger = await createUser(e2e.mongo);
    const admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    [authorToken, strangerToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(stranger),
      e2e.sign(admin),
    ]);
  });
  afterAll(async () => {
    await e2e.close();
  });

  const as = (token: string, req: request.Test) =>
    req.auth(token, { type: 'bearer' });
  const create = (payload: object = {}, token = authorToken) =>
    as(token, request(server()).post('/api/v1/blogs')).send({
      title: 'Đậu hũ sốt cà',
      content: '## Cách làm\nNấu đậu hũ với cà chua.',
      ...payload,
    });
  const patch = (id: string, payload: object, token = authorToken) =>
    as(token, request(server()).patch(`/api/v1/blogs/${id}`)).send(payload);
  const draft = async () => (await create().expect(201)).body as BlogBody;

  describe('validation', () => {
    it.each([
      ['a null title', { title: null }],
      ['a null content', { content: null }],
      ['a null status', { status: null }],
      ['null recipes', { recipeIds: null }],
      ['a whitespace-only title', { title: '    ' }],
      ['content over 50000 characters', { content: 'a'.repeat(50_001) }],
      ['a status the author cannot set', { status: 'PENDING_REVIEW' }],
    ])('refuses an edit with %s', async (_name, payload) => {
      const blog = await draft();

      await patch(blog.id, payload).expect(400);
    });

    it('refuses external covers and external markdown image URLs, while accepting blog storage media', async () => {
      const httpCover = await create({
        coverImageUrl: 'http://example.com/a.jpg',
      }).expect(400);
      expect((httpCover.body as ErrorBody).code).toBe('BLOG_COVER_NOT_ALLOWED');

      const httpsCover = await create({
        coverImageUrl: 'https://example.com/a.jpg',
      }).expect(400);
      expect((httpsCover.body as ErrorBody).code).toBe(
        'BLOG_COVER_NOT_ALLOWED',
      );

      const inlineExt = await create({
        content: '![ext](https://example.com/a.jpg)',
      }).expect(400);
      expect((inlineExt.body as ErrorBody).code).toBe('BLOG_MEDIA_NOT_ALLOWED');

      const refExt = await create({
        content: '![ext][pic]\n\n[pic]: https://example.com/a.jpg',
      }).expect(400);
      expect((refExt.body as ErrorBody).code).toBe('BLOG_MEDIA_NOT_ALLOWED');

      const storageUrl = e2e.app
        .get(StorageService)
        .publicObjectUrl(StorageTarget.Blogs, `blogs/${author.id}/img.jpg`);
      const ok = await create({
        coverImageUrl: storageUrl,
        content: `![hình](${storageUrl})\n\n[nguồn](https://example.com)`,
      }).expect(201);
      expect((ok.body as BlogBody).blog.coverImageUrl).toBe(storageUrl);
    });

    it('accepts exactly 50000 characters of content', async () => {
      await create({ content: 'a'.repeat(50_000) }).expect(201);
    });

    it('refuses a status filter other than DRAFT or PUBLISHED on my blogs', async () => {
      await as(
        authorToken,
        request(server()).get('/api/v1/blogs/mine?status=PENDING_REVIEW'),
      ).expect(400);
    });
  });

  describe('excerpt', () => {
    it('keeps at most 280 characters with whitespace collapsed', async () => {
      const content = `Mở   đầu\n\n${'chữ '.repeat(200)}`;

      const blog = (await create({ content }).expect(201)).body as BlogBody;

      expect(Array.from(blog.blog.excerpt)).toHaveLength(280);
      expect(blog.blog.excerpt.startsWith('Mở đầu chữ')).toBe(true);
      expect(blog.content).toBe(content);
    });
  });

  describe('state transitions', () => {
    it('publishes a draft and sets publishedAt once', async () => {
      const blog = await draft();

      const published = (
        await patch(blog.id, { status: 'PUBLISHED' }).expect(200)
      ).body as BlogBody;

      expect(blog.publishedAt).toBeNull();
      expect(published.status).toBe(PostStatus.PUBLISHED);
      expect(published.publishedAt).not.toBeNull();
    });

    it('does not check a public blog again when it is published again unchanged', async () => {
      const blog = (await create({ status: 'PUBLISHED' }).expect(201))
        .body as BlogBody;

      const again = (await patch(blog.id, { status: 'PUBLISHED' }).expect(200))
        .body as BlogBody;

      expect(again.status).toBe(PostStatus.PUBLISHED);
      expect(again.publishedAt).toBe(blog.publishedAt);
    });

    it('lets the author take a held blog back to a draft, out of the admin queue', async () => {
      const held = (
        await create({
          status: 'PUBLISHED',
          content: `Nội dung ${BORDERLINE_MARKER}`,
        }).expect(201)
      ).body as BlogBody;

      const withdrawn = (await patch(held.id, { status: 'DRAFT' }).expect(200))
        .body as BlogBody;
      const late = await as(
        adminToken,
        request(server()).post(`/api/v1/admin/posts/${held.id}/moderation`),
      )
        .send({ decision: 'APPROVE' })
        .expect(409);

      expect(held.status).toBe(PostStatus.PENDING_REVIEW);
      expect(withdrawn.status).toBe(PostStatus.DRAFT);
      expect((late.body as ErrorBody).code).toBe('POST_NOT_REVIEWABLE');
    });

    it('does not let an author publish a held blog past review by re-sending only its links', async () => {
      const held = (
        await create({
          status: 'PUBLISHED',
          content: `Nội dung ${BORDERLINE_MARKER}`,
        }).expect(201)
      ).body as BlogBody;

      const resent = (await patch(held.id, { recipeIds: [] }).expect(200))
        .body as BlogBody;

      expect(resent.status).not.toBe(PostStatus.PUBLISHED);
    });

    it('lets the author withdraw a blog stuck in PROCESSING to a draft', async () => {
      const stuck = await createPost(e2e.mongo, {
        authorId: author.id,
        type: PostType.BLOG,
        status: PostStatus.PROCESSING,
        publishedAt: null,
        body: null,
        blog: {
          title: 'Kẹt',
          content: 'nội dung',
          excerpt: 'nội dung',
          coverImageUrl: null,
          recipeIds: [],
        },
      });

      const response = await patch(stuck.id, { status: 'DRAFT' }).expect(200);

      expect((response.body as BlogBody).status).toBe(PostStatus.DRAFT);
    });
  });

  describe('routes that mix posts and blogs', () => {
    it('answers 404 on blog routes for a short post', async () => {
      const short = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'ngắn',
      });

      await request(server()).get(`/api/v1/blogs/${short.id}`).expect(404);
      await patch(short.id, { title: 'x' }).expect(404);
      await as(
        authorToken,
        request(server()).delete(`/api/v1/blogs/${short.id}`),
      ).expect(404);
      expect(
        await model<Post>('Post').exists({ _id: short.id }),
      ).not.toBeNull();
    });

    it('hides a draft from strangers on GET /posts/:id too', async () => {
      const blog = await draft();

      await as(
        strangerToken,
        request(server()).get(`/api/v1/posts/${blog.id}`),
      ).expect(404);
      await as(
        authorToken,
        request(server()).get(`/api/v1/posts/${blog.id}`),
      ).expect(200);
    });

    it('answers 404 to a stranger deleting a published blog and keeps it', async () => {
      const blog = (await create({ status: 'PUBLISHED' }).expect(201))
        .body as BlogBody;

      await as(
        strangerToken,
        request(server()).delete(`/api/v1/blogs/${blog.id}`),
      ).expect(404);
      await request(server()).get(`/api/v1/blogs/${blog.id}`).expect(200);
    });
  });

  describe('blog AI assistant guard rails', () => {
    const userMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Viết lại đoạn này' }],
    };
    const editor = { title: '', content: '' };
    const chat = (payload: object, token = authorToken) =>
      as(token, request(server()).post('/api/v1/blogs/ai/chat')).send(payload);

    it('needs a session', async () => {
      await request(server())
        .post('/api/v1/blogs/ai/chat')
        .send({ messages: [userMessage], editor })
        .expect(401);
    });

    it('refuses no messages and 41 messages', async () => {
      await chat({ messages: [], editor }).expect(400);
      await chat({
        messages: Array.from({ length: 41 }, (_, index) => ({
          ...userMessage,
          id: `m${index}`,
        })),
        editor,
      }).expect(400);
    });

    it('refuses a request without the editor state before using the allowance', async () => {
      // BUG-3: The required `editor` field is not enforced, so the request reaches quota + model
      const response = await chat({ messages: [userMessage] });

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('refuses an editor state of the wrong type', async () => {
      const response = await chat({ messages: [userMessage], editor: null });

      expect(response.status).toBe(400);
    });

    it('refuses an editor title over 150 characters', async () => {
      await chat({
        messages: [userMessage],
        editor: { title: 'a'.repeat(151), content: '' },
      }).expect(400);
    });

    it('answers 404 for a blogId that is somebody else’s blog', async () => {
      const theirs = (await create({}, strangerToken).expect(201))
        .body as BlogBody;

      await chat({
        messages: [userMessage],
        editor,
        blogId: theirs.id,
      }).expect(404);
    });

    it('answers 404 for a blogId that is a short post', async () => {
      const short = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'ngắn',
      });

      await chat({
        messages: [userMessage],
        editor,
        blogId: short.id,
      }).expect(404);
    });

    it('refuses a malformed history with BLOG_AI_INVALID_MESSAGES', async () => {
      const response = await chat({
        messages: [{ id: 'x', role: 'wizard', parts: 'nope' }],
        editor,
      }).expect(400);

      expect((response.body as ErrorBody).code).toBe(
        'BLOG_AI_INVALID_MESSAGES',
      );
    });

    it('answers 404 for an unknown blogId', async () => {
      await chat({
        messages: [userMessage],
        editor,
        blogId: randomUUID(),
      }).expect(404);
    });
  });
});
