import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  type Ingredient,
  type Recipe,
  type User,
  UserRole,
} from '../src/mongo/models';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createIngredient, createRecipe, createUser } from './fixtures';

describe('Recipes and ingredients (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let member: User;
  let adminToken: string;
  let memberToken: string;
  let tofu: Ingredient;
  let honey: Ingredient;
  let body: object;
  const server = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp('recipes_e2e');
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    member = await createUser(e2e.mongo, { username: 'vedora.member' });
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
    tofu = await createIngredient(e2e.mongo, { name: 'Đậu hũ' });
    honey = await createIngredient(e2e.mongo, { name: 'Mật ong' });
    await e2e.mongo.connection.model('IncompatibilityRule').create({
      _id: randomUUID(),
      aIngredientId: tofu.id,
      bIngredientId: honey.id,
      reason: 'Dễ gây đầy bụng',
    });
    body = {
      title: ' Đậu hũ sốt cà ',
      servings: 2,
      prepMinutes: 10,
      steps: ['Chiên đậu', 'Nấu sốt'],
      ingredients: [
        { ingredientId: tofu.id, quantity: 200.5, unit: 'g' },
        { ingredientId: honey.id },
      ],
    };
  });

  afterAll(async () => {
    await e2e.close();
  });

  const post = (path: string, token = adminToken) =>
    request(server()).post(path).set('Authorization', `Bearer ${token}`);

  it.each([
    'recipes',
    'ingredients',
    'ingredient-groups',
    'incompatibility-rules',
  ])('keeps /admin/%s to admins', async (path) => {
    await request(server()).get(`/api/v1/admin/${path}`).expect(401);
    await request(server())
      .get(`/api/v1/admin/${path}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });

  it('creates a recipe and reports its incompatible ingredients', async () => {
    const response = await post('/api/v1/admin/recipes').send(body).expect(201);
    expect(response.body).toMatchObject({
      ingredientCount: 2,
      conflictCount: 1,
      ingredients: [
        { name: 'Đậu hũ', quantity: 200.5, unit: 'g' },
        { name: 'Mật ong', quantity: null },
      ],
      conflicts: [{ a: { name: 'Đậu hũ' }, b: { name: 'Mật ong' } }],
    });
    const stored = await e2e.mongo.connection
      .model<Recipe>('Recipe')
      .findOne({ _id: (response.body as { id: string }).id });
    expect(stored).toMatchObject({
      title: 'Đậu hũ sốt cà',
      createdById: admin.id,
    });
  });

  it('rejects a recipe that lists an ingredient twice', async () => {
    await post('/api/v1/admin/recipes')
      .send({
        ...body,
        ingredients: [{ ingredientId: tofu.id }, { ingredientId: tofu.id }],
      })
      .expect(400);
  });

  it('rejects a recipe that names an ingredient that does not exist', async () => {
    const response = await post('/api/v1/admin/recipes')
      .send({ ...body, ingredients: [{ ingredientId: randomUUID() }] })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'UNKNOWN_REFERENCE' });
  });

  it('stores a dish photo link and accepts https only', async () => {
    const imageUrl = 'https://upload.wikimedia.org/dish.jpg';
    const response = await post('/api/v1/admin/recipes')
      .send({ ...body, imageUrl })
      .expect(201);
    expect(response.body).toMatchObject({ imageUrl });
    await post('/api/v1/admin/recipes')
      .send({ ...body, imageUrl: 'http://example.com/dish.jpg' })
      .expect(400);
  });

  it('answers 409 when deleting an ingredient a recipe uses', async () => {
    const used = await createIngredient(e2e.mongo);
    await createRecipe(e2e.mongo, {}, [used.id]);
    const response = await request(server())
      .delete(`/api/v1/admin/ingredients/${used.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(response.body).toMatchObject({ code: 'INGREDIENT_IN_USE' });
  });

  it('checks a set of ingredients for conflicts', async () => {
    const response = await post('/api/v1/admin/recipes/conflicts')
      .send({ ingredientIds: [tofu.id, honey.id] })
      .expect(200);
    expect(response.body).toHaveLength(1);
  });

  it('replaces what a signed-in user does not eat', async () => {
    const dietary = {
      ingredientIds: [tofu.id],
      groupIds: [],
      likedIngredientIds: [honey.id],
    };
    await request(server()).put('/api/v1/dietary/me').send(dietary).expect(401);
    const response = await request(server())
      .put('/api/v1/dietary/me')
      .set('Authorization', `Bearer ${memberToken}`)
      .send(dietary)
      .expect(200);
    expect(response.body).toEqual({
      ingredients: [{ id: tofu.id, name: 'Đậu hũ' }],
      groups: [],
      liked: [{ id: honey.id, name: 'Mật ong' }],
    });
    const stored = await e2e.mongo.connection
      .model<User>('User')
      .findOne({ _id: member.id });
    expect(stored?.avoidedIngredientIds).toEqual([tofu.id]);
  });

  it('refuses an ingredient that is both liked and avoided', async () => {
    const response = await request(server())
      .put('/api/v1/dietary/me')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        ingredientIds: [tofu.id],
        groupIds: [],
        likedIngredientIds: [tofu.id],
      })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'CONFLICTING_PREFERENCE' });
  });
});
