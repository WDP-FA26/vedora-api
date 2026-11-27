import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  CaptionStatus,
  type Ingredient,
  MediaStatus,
  type User,
  UserRole,
} from '@src/mongo/models.js';
import type {
  DraftCatalog,
  DraftRequest,
} from '@src/recipes/drafts/recipe-draft.js';
import {
  type DraftResult,
  RecipeDraftGenerator,
} from '@src/recipes/drafts/recipe-draft.generator.js';
import type { RecipeDraftDto } from '@src/recipes/dto/recipe-draft.dto.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import {
  createIngredient,
  createMedia,
  createPost,
  createUser,
} from '@test/support/fixtures.js';

interface ErrorBody {
  code: string;
  details?: Record<string, unknown>;
}

describe('AI recipe drafts (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let adminToken: string;
  let memberToken: string;
  let tofu: Ingredient;
  const groupId = randomUUID();
  const noRecipe = (): DraftResult => ({
    output: { recipe: null, researchCalories: false },
    calorieResearch: 'SKIPPED',
  });
  const calls: (DraftRequest & { catalog: DraftCatalog })[] = [];
  let answer: (catalog: DraftCatalog) => DraftResult = noRecipe;
  const generator = {
    modelId: 'fake/draft',
    generate: (request: DraftRequest, catalog: DraftCatalog) => {
      calls.push({ ...request, catalog });
      return Promise.resolve(answer(catalog));
    },
  };
  const server = () => e2e.app.getHttpServer();
  const draft = (body: object, token = adminToken) =>
    request(server())
      .post('/api/v1/admin/recipes/drafts')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  function refOf(
    entries: Map<string, { id: string }>,
    id: string,
  ): string | null {
    for (const [ref, entry] of entries) {
      if (entry.id === id) return ref;
    }
    return null;
  }

  beforeAll(async () => {
    e2e = await createE2eApp('recipe_drafts_e2e', (builder) =>
      builder.overrideProvider(RecipeDraftGenerator).useValue(generator),
    );
    admin = await createUser(e2e.mongo, {
      username: 'draft.admin',
      role: UserRole.ADMIN,
    });
    const member = await createUser(e2e.mongo, { username: 'draft.member' });
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
    tofu = await createIngredient(e2e.mongo, {
      name: 'Đậu hũ',
      aliases: ['đậu phụ'],
    });
    await createIngredient(e2e.mongo, { name: 'Cà chua' });
    await e2e.mongo.connection.model('IngredientGroup').create({
      _id: groupId,
      name: 'Nấm',
      ingredientIds: [],
    });
  });

  afterAll(async () => {
    await e2e?.close();
  });

  beforeEach(() => {
    calls.length = 0;
    answer = noRecipe;
  });

  it('keeps drafts to admins', async () => {
    await request(server())
      .post('/api/v1/admin/recipes/drafts')
      .send({ text: 'x' })
      .expect(401);
    await draft({ text: 'x' }, memberToken).expect(403);
  });

  it('drafts a recipe from a pasted caption, matched to the catalog', async () => {
    answer = (catalog) => ({
      calorieResearch: 'DONE',
      output: {
        researchCalories: true,
        recipe: {
          title: 'Đậu hũ sốt cà chua',
          description: null,
          tag: null,
          servings: 2,
          prepMinutes: null,
          cookMinutes: 15,
          ingredients: [
            {
              name: 'tàu hũ',
              quantity: 300,
              unit: 'g',
              note: 'cắt khối',
              catalogRef: refOf(catalog.ingredients, tofu.id),
              aliases: [],
              groupRefs: [],
            },
            {
              name: 'cà chua',
              quantity: 2,
              unit: 'quả',
              note: null,
              catalogRef: null,
              aliases: [],
              groupRefs: [],
            },
            {
              name: 'nấm đông cô',
              quantity: null,
              unit: null,
              note: null,
              catalogRef: null,
              aliases: ['nấm hương'],
              groupRefs: [refOf(catalog.groups, groupId) ?? ''],
            },
          ],
          steps: ['Chiên đậu.', 'Nấu sốt cà chua.'],
        },
      },
    });

    const response = await draft({
      text: '  Đậu hũ sốt cà chua: 300g tàu hũ, 2 quả cà chua, nấm đông cô.  ',
    }).expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].parts).toEqual([
      {
        label: 'Pasted caption',
        text: 'Đậu hũ sốt cà chua: 300g tàu hũ, 2 quả cà chua, nấm đông cô.',
      },
    ]);
    expect(calls[0].currentRecipe).toBeNull();
    expect(calls[0].instruction).toBeNull();
    const body = response.body as RecipeDraftDto;
    expect(body.untranscribedVideos).toBe(0);
    expect(body.calorieResearch).toBe('DONE');
    expect(body.recipe).toMatchObject({
      title: 'Đậu hũ sốt cà chua',
      servings: 2,
      cookMinutes: 15,
      steps: ['Chiên đậu.', 'Nấu sốt cà chua.'],
    });
    expect(body.recipe?.ingredients).toEqual([
      {
        name: 'tàu hũ',
        quantity: 300,
        unit: 'g',
        note: 'cắt khối',
        match: { id: tofu.id, name: 'Đậu hũ' },
        suggestion: null,
      },
      expect.objectContaining({
        name: 'cà chua',
        match: expect.objectContaining({ name: 'Cà chua' }) as unknown,
        suggestion: null,
      }),
      {
        name: 'nấm đông cô',
        quantity: null,
        unit: null,
        note: null,
        match: null,
        suggestion: {
          name: 'nấm đông cô',
          aliases: ['nấm hương'],
          groups: [{ id: groupId, name: 'Nấm' }],
        },
      },
    ]);
  });

  it('reads a post with its transcripts and counts videos still transcribing', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: admin.id,
      body: 'Món chay dễ làm',
    });
    await createMedia(e2e.mongo, {
      ownerId: admin.id,
      postId: post.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.READY,
      transcript: 'Hôm nay mình làm đậu hũ sốt cà.',
    });
    await createMedia(e2e.mongo, {
      ownerId: admin.id,
      postId: post.id,
      position: 1,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.TRANSCRIBING,
    });

    const response = await draft({ postId: post.id }).expect(200);

    expect(calls[0].parts).toEqual([
      { label: 'Post text', text: 'Món chay dễ làm' },
      { label: 'What video 1 says', text: 'Hôm nay mình làm đậu hũ sốt cà.' },
    ]);
    expect(response.body).toEqual({
      recipe: null,
      untranscribedVideos: 1,
      calorieResearch: 'SKIPPED',
    });
  });

  it('reads only the chosen video when mediaId is given', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: admin.id,
      body: 'Hai món chay',
    });
    await createMedia(e2e.mongo, {
      ownerId: admin.id,
      postId: post.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.READY,
      transcript: 'Món một: canh nấm.',
    });
    const second = await createMedia(e2e.mongo, {
      ownerId: admin.id,
      postId: post.id,
      position: 1,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.READY,
      transcript: 'Món hai: đậu hũ sốt cà.',
    });
    const elsewhere = await createMedia(e2e.mongo, {
      ownerId: admin.id,
      status: MediaStatus.READY,
    });

    await draft({ postId: post.id, mediaId: second.id }).expect(200);
    expect(calls[0].parts).toEqual([
      { label: 'Post text', text: 'Hai món chay' },
      { label: 'What video 2 says', text: 'Món hai: đậu hũ sốt cà.' },
    ]);

    await draft({ postId: post.id, mediaId: elsewhere.id }).expect(404);
    const orphan = await draft({ mediaId: second.id, text: 'x' }).expect(400);
    expect((orphan.body as ErrorBody).code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(1);
  });

  it('rejects a missing, doubled or empty source without calling the AI', async () => {
    const empty = await createPost(e2e.mongo, {
      authorId: admin.id,
      body: null,
    });
    await createMedia(e2e.mongo, {
      ownerId: admin.id,
      postId: empty.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.TRANSCRIBING,
    });

    const neither = await draft({}).expect(400);
    expect((neither.body as ErrorBody).code).toBe('BAD_REQUEST');
    const both = await draft({ postId: empty.id, text: 'x' }).expect(400);
    expect((both.body as ErrorBody).code).toBe('BAD_REQUEST');
    const formAndText = await draft({
      text: 'x',
      currentRecipe: 'Tên món: Canh nấm',
    }).expect(400);
    expect((formAndText.body as ErrorBody).code).toBe('BAD_REQUEST');
    const requestOnly = await draft({ instruction: 'Tính kcal' }).expect(400);
    expect((requestOnly.body as ErrorBody).code).toBe('BAD_REQUEST');
    await draft({
      currentRecipe: 'Tên món: Canh nấm',
      instruction: 'x'.repeat(2001),
    }).expect(400);
    const nothing = await draft({ postId: empty.id }).expect(400);
    expect(nothing.body as ErrorBody).toMatchObject({
      code: 'EMPTY_RECIPE_SOURCE',
      details: { untranscribedVideos: 1 },
    });
    await draft({ postId: randomUUID() }).expect(404);
    expect(calls).toHaveLength(0);
  });

  it("revises the form's recipe with the admin's request kept apart from the data", async () => {
    answer = () => ({
      calorieResearch: 'FAILED',
      output: {
        researchCalories: true,
        recipe: {
          title: 'Canh nấm',
          description: null,
          tag: null,
          servings: 4,
          prepMinutes: null,
          cookMinutes: null,
          caloriesPerServing: 120,
          ingredients: [],
          steps: ['Nấu nấm.'],
        },
      },
    });

    const response = await draft({
      currentRecipe: '  Tên món: Canh nấm\nKhẩu phần: 2  ',
      instruction: '  Đổi thành 4 người và tính lại kcal.  ',
    }).expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      parts: [],
      currentRecipe: 'Tên món: Canh nấm\nKhẩu phần: 2',
      instruction: 'Đổi thành 4 người và tính lại kcal.',
    });
    const body = response.body as RecipeDraftDto;
    expect(body.calorieResearch).toBe('FAILED');
    expect(body.recipe).toMatchObject({
      title: 'Canh nấm',
      servings: 4,
      caloriesPerServing: 120,
    });
  });

  it('passes the admin request along with a post', async () => {
    const post = await createPost(e2e.mongo, {
      authorId: admin.id,
      body: 'Canh nấm chay',
    });
    await draft({ postId: post.id, instruction: 'Chỉ lấy món canh' }).expect(
      200,
    );
    expect(calls[0]).toMatchObject({
      parts: [{ label: 'Post text', text: 'Canh nấm chay' }],
      currentRecipe: null,
      instruction: 'Chỉ lấy món canh',
    });
  });

  it('reports an AI failure as an upstream error', async () => {
    answer = () => {
      throw new Error('model down');
    };
    const response = await draft({ text: 'Đậu hũ sốt cà' }).expect(502);
    expect((response.body as ErrorBody).code).toBe('EXTERNAL_SERVICE_FAILED');
  });
});
