import request from 'supertest';
import { TurnstileService } from '../../src/captcha/turnstile.service.js';
import { CaptionService } from '../../src/media/captions/caption.service.js';
import {
  CaptionStatus,
  MediaStatus,
  Notification,
  Post,
  PostComment,
  PostSummary,
  PostSummaryStatus,
  PostType,
  User,
  UserRole,
} from '../../src/mongo/models.js';
import type { CommentPageDto } from '../../src/posts/dto/comment.dto.js';
import { PostSummariesService } from '../../src/posts/summaries/post-summaries.service.js';
import {
  PostSummaryGenerator,
  type SummaryOutput,
  type SummarySourcePart,
} from '../../src/posts/summaries/post-summary.generator.js';
import type { PostSummaryDto } from '../../src/posts/summaries/post-summary.dto.js';
import {
  SYSTEM_ACCOUNT,
  SYSTEM_ACCOUNT_ID,
} from '../../src/users/system-account.js';
import {
  createE2eApp,
  type E2eApp,
  VIOLATION_MARKER,
} from '../support/e2e-app.js';
import { createMedia, createPost, createUser } from '../support/fixtures.js';

const RECIPE_TEXT =
  'Hôm nay mình làm đậu hũ sốt cà chua chay cho 2 người. Nguyên liệu gồm 300 g đậu hũ non cắt khối, 3 quả cà chua, 1 muỗng canh nước tương và hành lá. ' +
  'Đầu tiên chiên đậu hũ vàng đều các mặt. Sau đó xào cà chua cho mềm, nêm nước tương, rồi cho đậu vào rim khoảng 10 phút. Rắc hành lá và tắt bếp.';

const RECIPE_SUMMARY: SummaryOutput = {
  worthSummarizing: true,
  language: 'vi',
  summary: 'Cách làm đậu hũ sốt cà chua chay đơn giản cho 2 người.',
  recipe: {
    title: 'Đậu hũ sốt cà chua',
    description: null,
    tag: null,
    servings: 2,
    prepMinutes: null,
    cookMinutes: 10,
    ingredients: [
      { name: 'đậu hũ non', quantity: 300, unit: 'g', note: 'cắt khối' },
      { name: 'cà chua', quantity: 3, unit: 'quả', note: null },
      { name: 'nước tương', quantity: 1, unit: 'muỗng canh', note: null },
      { name: 'hành lá', quantity: null, unit: null, note: null },
      { name: '  ', quantity: -1, unit: null, note: null },
    ],
    steps: [
      'Chiên đậu hũ vàng đều các mặt.',
      'Xào cà chua cho mềm, nêm nước tương.',
      'Cho đậu vào rim khoảng 10 phút.',
      '',
    ],
  },
};

describe('Vedora AI post summaries (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let reader: User;
  let admin: User;
  const calls: SummarySourcePart[][] = [];
  let answer: () => Promise<SummaryOutput> = () =>
    Promise.resolve(RECIPE_SUMMARY);
  const generator = {
    modelId: 'fake/summary',
    generate: (parts: SummarySourcePart[]) => {
      calls.push(parts);
      return answer();
    },
  };
  const server = () => e2e.app.getHttpServer();
  const service = () => e2e.app.get(PostSummariesService);
  const summaries = () =>
    e2e.mongo.connection.model<PostSummary>(PostSummary.name);
  const comments = () =>
    e2e.mongo.connection.model<PostComment>(PostComment.name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_summaries_e2e', (builder) =>
      builder
        .overrideProvider(PostSummaryGenerator)
        .useValue(generator)
        .overrideProvider(TurnstileService)
        .useValue({ verify: () => Promise.resolve(true) }),
    );
    author = await createUser(e2e.mongo, { username: 'summary.author' });
    reader = await createUser(e2e.mongo, { username: 'summary.reader' });
    admin = await createUser(e2e.mongo, {
      username: 'summary.admin',
      role: UserRole.ADMIN,
    });
  });

  afterAll(async () => {
    await e2e?.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    answer = () => Promise.resolve(RECIPE_SUMMARY);
    await e2e.mongo.connection.model<Post>(Post.name).deleteMany({});
    await summaries().deleteMany({});
    await comments().deleteMany({});
  });

  it('summarizes a video post from its transcript, stores the recipe and comments as Vedora AI', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: 'Đậu hũ sốt cà chua',
    });
    await createMedia(e2e.mongo, {
      ownerId: author.id,
      postId: post.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.READY,
      transcript: RECIPE_TEXT,
    });

    await service().drain();
    await service().drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].map((part) => part.label)).toEqual([
      'Post text',
      'What video 1 says',
    ]);
    const stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.READY);
    expect(stored?.model).toBe('fake/summary');
    expect(stored?.recipe?.ingredients).toHaveLength(4);
    expect(stored?.recipe?.steps).toHaveLength(3);
    expect(stored?.commentId).toEqual(expect.any(String));

    const page = await request(server())
      .get(`/api/v1/posts/${post.id}/comments`)
      .expect(200);
    const { items } = page.body as CommentPageDto;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(stored?.commentId);
    expect(items[0].author).toMatchObject({
      id: SYSTEM_ACCOUNT_ID,
      username: SYSTEM_ACCOUNT.username,
      isSystem: true,
    });
    expect(items[0].body).toContain('Nguyên liệu:');
    expect(items[0].body).toContain('• 300 g đậu hũ non (cắt khối)');
    expect(items[0].body).toContain('1. Chiên đậu hũ vàng đều các mặt.');

    const summary = await request(server())
      .get(`/api/v1/posts/${post.id}/summary`)
      .expect(200);
    const body = summary.body as PostSummaryDto;
    expect(body.status).toBe(PostSummaryStatus.READY);
    expect(body.recipe?.servings).toBe(2);
    expect(body.recipe?.ingredients[0]).toEqual({
      name: 'đậu hũ non',
      quantity: 300,
      unit: 'g',
      note: 'cắt khối',
    });
  });

  it('waits for a video to be transcribed before summarizing', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await createMedia(e2e.mongo, {
      ownerId: author.id,
      postId: post.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.TRANSCRIBING,
    });
    const captionsActive = vi
      .spyOn(CaptionService.prototype, 'active', 'get')
      .mockReturnValue(true);
    try {
      await service().drain();
    } finally {
      captionsActive.mockRestore();
    }
    expect(calls).toHaveLength(0);
    expect(await summaries().countDocuments({ postId: post.id })).toBe(0);
  });

  it('summarizes a blog from its title and content', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      type: PostType.BLOG,
      blog: {
        title: 'Đậu hũ sốt cà',
        content: RECIPE_TEXT,
        coverImageUrl: null,
        excerpt: '',
        recipeIds: [],
      },
    });
    await service().drain();
    expect(calls[0].map((part) => part.label)).toEqual([
      'Blog title',
      'Blog content',
    ]);
    const stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.READY);
  });

  it('skips short posts without calling the model, and posts nothing', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: 'Chào cả nhà!',
    });
    await service().drain();
    expect(calls).toHaveLength(0);
    const stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.SKIPPED);
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
  });

  it('stores SKIPPED without a comment when the model finds nothing to summarize', async () => {
    answer = () =>
      Promise.resolve({
        worthSummarizing: false,
        language: 'vi',
        summary: '',
        recipe: null,
      });
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await service().drain();
    const stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.SKIPPED);
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
  });

  it('posts nothing when the summary fails moderation', async () => {
    answer = () =>
      Promise.resolve({
        ...RECIPE_SUMMARY,
        summary: `${VIOLATION_MARKER} tóm tắt`,
      });
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await service().drain();
    const stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.SKIPPED);
    expect(stored?.error).toBe('CONTENT_REJECTED');
    expect(stored?.summary).toBeNull();
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
  });

  it('leaves posts published before the window alone', async () => {
    await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
      publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    await service().drain();
    expect(calls).toHaveLength(0);
    expect(await summaries().countDocuments({})).toBe(0);
  });

  it('retries a failed summary after it goes stale and gives up after the last attempt', async () => {
    answer = () => Promise.reject(new Error('model unavailable'));
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await service().drain();
    let stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.status).toBe(PostSummaryStatus.PENDING);
    expect(stored?.attempts).toBe(1);
    expect(stored?.error).toContain('model unavailable');

    const stale = new Date(Date.now() - 60 * 60 * 1000);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await summaries().updateOne(
        { postId: post.id },
        { $set: { claimedAt: stale } },
      );
      await service().drain();
    }
    stored = await summaries().findOne({ postId: post.id }).exec();
    expect(stored?.attempts).toBe(3);
    expect(stored?.status).toBe(PostSummaryStatus.FAILED);
    expect(calls).toHaveLength(3);
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
  });

  it('does not post again after the author deletes the AI comment', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await service().drain();
    const stored = await summaries().findOne({ postId: post.id }).exec();
    const token = await e2e.sign(author);
    await request(server())
      .delete(`/api/v1/posts/${post.id}/comments/${stored?.commentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await service().drain();
    expect(calls).toHaveLength(1);
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
    const after = await summaries().findOne({ postId: post.id }).exec();
    expect(after?.status).toBe(PostSummaryStatus.READY);
    expect(after?.commentId).toBeNull();
  });

  it('sends no notification for a reply to the AI comment', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      body: RECIPE_TEXT,
    });
    await service().drain();
    const stored = await summaries().findOne({ postId: post.id }).exec();
    const token = await e2e.sign(reader);
    await request(server())
      .post(`/api/v1/posts/${post.id}/comments/${stored?.commentId}/replies`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'Cảm ơn bản tóm tắt!' })
      .expect(201);
    const notifications = e2e.mongo.connection.model<Notification>(
      Notification.name,
    );
    expect(
      await notifications.countDocuments({ recipientId: SYSTEM_ACCOUNT_ID }),
    ).toBe(0);
  });

  describe('the system account', () => {
    beforeAll(async () => {
      await service().ensureSystemAccount();
    });

    it('cannot sign in or use a token', async () => {
      await request(server())
        .post('/api/v1/auth/login')
        .send({
          username: SYSTEM_ACCOUNT.username,
          password: 'any-password-1',
          turnstileToken: 'ok',
        })
        .expect(401);
      const token = await e2e.sign({
        id: SYSTEM_ACCOUNT_ID,
        username: SYSTEM_ACCOUNT.username,
      });
      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('has no public profile and cannot be followed', async () => {
      await request(server())
        .get(`/api/v1/profiles/${SYSTEM_ACCOUNT_ID}`)
        .expect(404);
      const token = await e2e.sign(reader);
      await request(server())
        .put(`/api/v1/profiles/${SYSTEM_ACCOUNT_ID}/follow`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('is hidden from the admin user list and cannot be managed', async () => {
      const token = await e2e.sign(admin);
      const list = await request(server())
        .get('/api/v1/users')
        .query({ q: SYSTEM_ACCOUNT.username, limit: 50 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(0);
      await request(server())
        .get(`/api/v1/users/${SYSTEM_ACCOUNT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(server())
        .delete(`/api/v1/users/${SYSTEM_ACCOUNT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'test' })
        .expect(404);
    });

    it('keeps its username when someone tries to register it', async () => {
      await request(server())
        .post('/api/v1/auth/register')
        .send({
          username: SYSTEM_ACCOUNT.username,
          fullName: 'Impostor',
          email: 'impostor@example.test',
          password: 'Str0ng-password!',
        })
        .expect(409);
      const users = e2e.mongo.connection.model<User>(User.name);
      expect(await users.exists({ _id: SYSTEM_ACCOUNT_ID })).toBeTruthy();
    });
  });
});
