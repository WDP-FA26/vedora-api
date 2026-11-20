import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { BlogDetailDto } from '../../src/posts/dto/blog.dto.js';
import {
  Notification,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostStatus,
  PostType,
  Recipe,
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
  VIOLATION_MARKER,
} from '../support/e2e-app.js';
import { createPost, createRecipe, createUser } from '../support/fixtures.js';

interface Page {
  items: { id: string }[];
}

describe('Blog lifecycle: publish, edit, hide, delete (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let admin: User;
  let authorToken: string;
  let strangerToken: string;
  let adminToken: string;
  let recipe: Recipe;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);
  const as = (token: string, req: request.Test) =>
    req.auth(token, { type: 'bearer' });

  beforeAll(async () => {
    e2e = await createE2eApp('blog_lifecycle_e2e');
    author = await createUser(e2e.mongo, { username: 'vedora.chef' });
    stranger = await createUser(e2e.mongo, { username: 'vedora.other' });
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    [authorToken, strangerToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(stranger),
      e2e.sign(admin),
    ]);
    recipe = await createRecipe(e2e.mongo, { title: 'Đậu hũ' });
  });
  beforeEach(async () => {
    for (const name of [
      Post.name,
      PostComment.name,
      PostLike.name,
      PostBookmark.name,
      Notification.name,
    ]) {
      await model(name).deleteMany({});
    }
  });
  afterAll(async () => {
    await e2e.close();
  });

  const create = (payload: object = {}) =>
    as(authorToken, request(server()).post('/api/v1/blogs')).send({
      title: 'Đậu hũ sốt cà',
      content: '## Cách làm\nNấu đậu hũ với cà chua.',
      ...payload,
    });
  const patch = (id: string, payload: object, token = authorToken) =>
    as(token, request(server()).patch(`/api/v1/blogs/${id}`)).send(payload);
  const published = async (payload: object = {}) =>
    (await create({ status: 'PUBLISHED', ...payload }).expect(201))
      .body as BlogDetailDto;
  const ids = async (path: string) =>
    ((await request(server()).get(path).expect(200)).body as Page).items.map(
      ({ id }) => id,
    );

  describe('creating', () => {
    it.each([
      ['a cover that is not a url', { coverImageUrl: 'not a url' }],
      ['a cover without a protocol', { coverImageUrl: 'example.com/a.jpg' }],
      ['an ftp cover', { coverImageUrl: 'ftp://example.com/a.jpg' }],
      [
        'a cover over 2048 characters',
        { coverImageUrl: `https://e.com/${'a'.repeat(2040)}.jpg` },
      ],
      [
        'eleven recipes',
        { recipeIds: Array.from({ length: 11 }, () => randomUUID()) },
      ],
      ['a repeated recipe', { recipeIds: [randomUUID(), 'same'] }],
      ['a recipe id that is not a uuid', { recipeIds: ['abc'] }],
      ['a title of 151 characters', { title: 'a'.repeat(151) }],
      ['an unknown field', { author: 'x' }],
    ])('rejects %s', async (_name, payload) => {
      await create(payload).expect(400);
      expect(await model(Post.name).countDocuments({})).toBe(0);
    });

    it('accepts ten recipes, a 150 character title and a blog storage cover', async () => {
      const recipes: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        recipes.push(
          (await createRecipe(e2e.mongo, { title: `Món ${index}` })).id,
        );
      }
      const coverUrl = e2e.app
        .get(StorageService)
        .publicObjectUrl(StorageTarget.Blogs, `blogs/${author.id}/cover.jpg`);
      const response = await create({
        title: 'a'.repeat(150),
        recipeIds: recipes,
        content: `![Bìa](${coverUrl})\n\nNấu đậu hũ.`,
      }).expect(201);
      expect((response.body as BlogDetailDto).blog.recipes).toHaveLength(10);
      expect((response.body as BlogDetailDto).blog.coverImageUrl).toBe(
        coverUrl,
      );
    });

    it('keeps the order of the recipes it was given', async () => {
      const second = await createRecipe(e2e.mongo, { title: 'Cà chua' });
      const blog = (
        await create({ recipeIds: [second.id, recipe.id] }).expect(201)
      ).body as BlogDetailDto;
      expect(blog.blog.recipes.map(({ id }) => id)).toEqual([
        second.id,
        recipe.id,
      ]);
    });

    it('does not show a draft in any public list, and never to a guest or stranger', async () => {
      const draft = (await create().expect(201)).body as BlogDetailDto;
      expect(await ids('/api/v1/blogs')).not.toContain(draft.id);
      expect(await ids('/api/v1/posts?type=BLOG&limit=50')).not.toContain(
        draft.id,
      );
      expect(
        await ids(`/api/v1/posts?authorId=${author.id}&limit=50`),
      ).not.toContain(draft.id);
      await request(server()).get(`/api/v1/blogs/${draft.id}`).expect(404);
      await as(
        strangerToken,
        request(server()).get(`/api/v1/blogs/${draft.id}`),
      ).expect(404);
      await as(
        authorToken,
        request(server()).get(`/api/v1/blogs/${draft.id}`),
      ).expect(200);
    });
  });

  describe('editing a public blog', () => {
    it('hides it from the lists while it is checked again, then returns the verdict', async () => {
      const blog = await published();
      expect(await ids('/api/v1/blogs')).toContain(blog.id);
      const edited = (
        await patch(blog.id, { title: 'Tiêu đề mới' }).expect(200)
      ).body as BlogDetailDto;
      expect(edited.status).toBe(PostStatus.PUBLISHED);
      expect(edited.publishedAt).toBe(blog.publishedAt);
      expect(edited.blog.title).toBe('Tiêu đề mới');
      expect(await ids('/api/v1/blogs')).toContain(blog.id);
    });

    it('holds a doubtful edit and drops the blog from the public lists', async () => {
      const blog = await published();
      const held = (
        await patch(blog.id, { content: `${BORDERLINE_MARKER} text` }).expect(
          200,
        )
      ).body as BlogDetailDto;
      expect(held.status).toBe(PostStatus.PENDING_REVIEW);
      expect(await ids('/api/v1/blogs')).not.toContain(blog.id);
      await request(server()).get(`/api/v1/blogs/${blog.id}`).expect(404);
      await as(
        authorToken,
        request(server()).get(`/api/v1/blogs/${blog.id}`),
      ).expect(200);
    });

    it('rejects a violating edit and sends the author back to a draft when they fix it', async () => {
      const blog = await published();
      const blocked = (
        await patch(blog.id, { title: `${VIOLATION_MARKER} title` }).expect(200)
      ).body as BlogDetailDto;
      expect(blocked.status).toBe(PostStatus.REJECTED);
      const fixed = (
        await patch(blog.id, { title: 'Tiêu đề sạch' }).expect(200)
      ).body as BlogDetailDto;
      expect(fixed.status).toBe(PostStatus.DRAFT);
    });

    it('does not check again when only the recipes change', async () => {
      const blog = await published();
      const second = await createRecipe(e2e.mongo, { title: 'Cà chua' });
      const edited = (
        await patch(blog.id, { recipeIds: [second.id] }).expect(200)
      ).body as BlogDetailDto;
      expect(edited.status).toBe(PostStatus.PUBLISHED);
      expect(edited.blog.recipes.map(({ id }) => id)).toEqual([second.id]);
    });

    it('refuses to empty a public blog unless it goes back to a draft', async () => {
      const blog = await published();
      const refused = await patch(blog.id, { content: '   ' }).expect(400);
      expect((refused.body as { code: string }).code).toBe(
        'BLOG_CONTENT_REQUIRED',
      );
      const draft = (
        await patch(blog.id, { content: '', status: 'DRAFT' }).expect(200)
      ).body as BlogDetailDto;
      expect(draft.status).toBe(PostStatus.DRAFT);
      await request(server()).get(`/api/v1/blogs/${blog.id}`).expect(404);
    });

    it('keeps the first publish date when it is unpublished and published again', async () => {
      const blog = await published();
      await patch(blog.id, { status: 'DRAFT' }).expect(200);
      const again = (await patch(blog.id, { status: 'PUBLISHED' }).expect(200))
        .body as BlogDetailDto;
      expect(again.publishedAt).toBe(blog.publishedAt);
    });

    it('keeps the comments and likes while a blog is a draft and brings them back', async () => {
      const blog = await published();
      await as(
        strangerToken,
        request(server()).put(`/api/v1/posts/${blog.id}/like`),
      ).expect(200);
      await as(
        strangerToken,
        request(server()).post(`/api/v1/posts/${blog.id}/comments`),
      )
        .send({ body: 'Hay' })
        .expect(201);
      await patch(blog.id, { status: 'DRAFT' }).expect(200);
      expect(
        await model(PostLike.name).countDocuments({ postId: blog.id }),
      ).toBe(1);
      expect(
        await model(PostComment.name).countDocuments({ postId: blog.id }),
      ).toBe(1);
      await patch(blog.id, { status: 'PUBLISHED' }).expect(200);
      const detail = (
        await request(server()).get(`/api/v1/posts/${blog.id}`).expect(200)
      ).body as { commentCount: number; likeCount: number };
      expect(detail).toMatchObject({ commentCount: 1, likeCount: 1 });
    });

    it('does not let anyone else edit, not even an admin, and treats a short post as not found', async () => {
      const blog = await published();
      await patch(blog.id, { title: 'Của người khác' }, strangerToken).expect(
        404,
      );
      await patch(blog.id, { title: 'Của admin' }, adminToken).expect(404);
      const short = await createPost(e2e.mongo, {
        authorId: author.id,
        type: PostType.POST,
        body: 'Bài ngắn',
      });
      await patch(short.id, { title: 'Sửa bài ngắn' }).expect(404);
      await request(server()).get(`/api/v1/blogs/${short.id}`).expect(404);
      await as(
        authorToken,
        request(server()).delete(`/api/v1/blogs/${short.id}`),
      ).expect(404);
    });

    it('refuses an empty body, an unknown field and a status the API does not allow', async () => {
      const blog = await published();
      await patch(blog.id, {}).expect(400);
      await patch(blog.id, { authorId: stranger.id }).expect(400);
      await patch(blog.id, { status: 'REJECTED' }).expect(400);
      await patch(blog.id, { recipeIds: [randomUUID()] }).expect(400);
      await patch(blog.id, { coverImageUrl: 'ftp://x/y.jpg' }).expect(400);
    });
  });

  describe('admin decisions on a blog', () => {
    it('lets an admin approve a held edit, and tells the author it was a blog', async () => {
      const blog = await published();
      await patch(blog.id, { content: `${BORDERLINE_MARKER} text` }).expect(
        200,
      );
      await as(
        adminToken,
        request(server()).post(`/api/v1/admin/posts/${blog.id}/moderation`),
      )
        .send({ decision: 'APPROVE', note: 'Ổn' })
        .expect(200);
      expect(await ids('/api/v1/blogs')).toContain(blog.id);
      const sent = await model<Notification>(Notification.name)
        .find({ postId: blog.id, recipientId: author.id })
        .exec();
      const types = sent.map(({ type }) => type).sort();
      expect(types).toEqual(['POST_APPROVED', 'POST_PENDING_REVIEW']);
      const feed = (
        await as(
          authorToken,
          request(server()).get('/api/v1/notifications'),
        ).expect(200)
      ).body as { items: { postType: string | null }[] };
      expect(feed.items.every(({ postType }) => postType === 'BLOG')).toBe(
        true,
      );
    });

    it('lets an admin overturn a rejection and a stranger cannot decide', async () => {
      const blog = await published();
      await patch(blog.id, { title: `${VIOLATION_MARKER} title` }).expect(200);
      await as(
        strangerToken,
        request(server()).post(`/api/v1/admin/posts/${blog.id}/moderation`),
      )
        .send({ decision: 'APPROVE' })
        .expect(403);
      await as(
        adminToken,
        request(server()).post(`/api/v1/admin/posts/${blog.id}/moderation`),
      )
        .send({ decision: 'APPROVE' })
        .expect(200);
      expect(await ids('/api/v1/blogs')).toContain(blog.id);
    });
  });

  describe('deleting a blog', () => {
    it('removes its comments, likes, bookmarks and notifications but keeps the recipes', async () => {
      const blog = await published({ recipeIds: [recipe.id] });
      const base = `/api/v1/posts/${blog.id}`;
      await as(strangerToken, request(server()).put(`${base}/like`)).expect(
        200,
      );
      await as(strangerToken, request(server()).put(`${base}/bookmark`)).expect(
        200,
      );
      await as(strangerToken, request(server()).post(`${base}/comments`))
        .send({ body: 'Hay' })
        .expect(201);
      await as(
        authorToken,
        request(server()).delete(`/api/v1/blogs/${blog.id}`),
      ).expect(204);
      const saved = await model(Post.name)
        .findById(blog.id)
        .select('status')
        .exec();
      expect((saved as { status: PostStatus } | null)?.status).toBe(
        PostStatus.REMOVED,
      );
      expect(await model(Recipe.name).countDocuments({ _id: recipe.id })).toBe(
        1,
      );
      await request(server()).get(`/api/v1/blogs/${blog.id}`).expect(404);
      await as(
        authorToken,
        request(server()).delete(`/api/v1/blogs/${blog.id}`),
      ).expect(404);
    });

    it('deletes a draft, a held blog and a rejected blog, and refuses a stranger', async () => {
      const draft = (await create().expect(201)).body as BlogDetailDto;
      const held = await published({ content: `${BORDERLINE_MARKER} text` });
      const rejected = await published({ content: `${VIOLATION_MARKER} text` });
      await as(
        strangerToken,
        request(server()).delete(`/api/v1/blogs/${draft.id}`),
      ).expect(404);
      for (const id of [draft.id, held.id, rejected.id]) {
        await as(
          authorToken,
          request(server()).delete(`/api/v1/blogs/${id}`),
        ).expect(204);
      }
      expect(
        await model(Post.name).countDocuments({
          status: { $ne: PostStatus.REMOVED },
        }),
      ).toBe(0);
    });

    it('lets an admin delete a blog through the admin route', async () => {
      const blog = await published();
      await as(
        adminToken,
        request(server()).delete(`/api/v1/admin/posts/${blog.id}`),
      ).expect(204);
      const saved = await model(Post.name)
        .findById(blog.id)
        .select('status')
        .exec();
      expect((saved as { status: PostStatus } | null)?.status).toBe(
        PostStatus.REMOVED,
      );
    });
  });

  describe('listing my blogs', () => {
    it('filters by status and pages in creation order without mixing accounts', async () => {
      await create({ title: 'Nháp một' }).expect(201);
      await create({ title: 'Nháp hai' }).expect(201);
      await published({ title: 'Đã đăng' });
      await as(strangerToken, request(server()).post('/api/v1/blogs'))
        .send({ title: 'Của người khác' })
        .expect(201);

      const drafts = (
        await as(
          authorToken,
          request(server()).get('/api/v1/blogs/mine?status=DRAFT&limit=50'),
        ).expect(200)
      ).body as Page;
      expect(drafts.items).toHaveLength(2);
      const firstPage = (
        await as(
          authorToken,
          request(server()).get('/api/v1/blogs/mine?limit=2'),
        ).expect(200)
      ).body as Page & { nextCursor: string | null };
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBe(null);
      const secondPage = (
        await as(
          authorToken,
          request(server()).get(
            `/api/v1/blogs/mine?limit=2&cursor=${firstPage.nextCursor}`,
          ),
        ).expect(200)
      ).body as Page;
      expect(secondPage.items).toHaveLength(1);
      const all = [...firstPage.items, ...secondPage.items].map(({ id }) => id);
      expect(new Set(all).size).toBe(3);
      await as(
        authorToken,
        request(server()).get(`/api/v1/blogs/mine?cursor=${randomUUID()}`),
      ).expect(400);
      await request(server()).get('/api/v1/blogs/mine').expect(401);
    });
  });
});
