import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createUser } from './fixtures';

const ROOT = '/api/v1/meal-plan/shopping-list';
describe('Shopping list API (e2e)', () => {
  let e2e: E2eApp;
  let token: string;
  beforeAll(async () => {
    e2e = await createE2eApp('shopping_e2e');
    token = await e2e.sign(
      await createUser(e2e.mongo, { username: 'shopping.user' }),
    );
  });
  afterAll(async () => {
    await e2e.close();
  });
  const get = (query = '') =>
    request(e2e.app.getHttpServer())
      .get(query ? `${ROOT}?${query}` : ROOT)
      .set('Authorization', `Bearer ${token}`);

  it('requires authentication', async () => {
    await request(e2e.app.getHttpServer()).get(ROOT).expect(401);
  });
  it('returns an empty private list with the full default week and explicit quantity basis', async () => {
    const response = await get().expect(200);
    expect(response.body).toEqual({
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      quantityBasis: 'RECIPE_PER_OCCURRENCE',
      items: [],
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(
      await e2e.mongo.connection.model('MealPlanEntry').countDocuments(),
    ).toBe(0);
  });
  it.each(['days=SUN,MON', 'days=SUN&days=MON'])(
    'accepts and orders weekday filter %s',
    async (query) => {
      const response = await get(query).expect(200);
      expect(response.body).toMatchObject({ days: ['MON', 'SUN'], items: [] });
    },
  );
  it.each([
    'days=',
    'days=mon',
    'days=FUNDAY',
    'days=MON,MON',
    'days=MON&days=MON',
    'days=MON,TUE,WED,THU,FRI,SAT,SUN,MON',
    'userId=other',
    'day=MON',
    'servings=3',
  ])('rejects invalid or unsupported query %s', async (query) => {
    await get(query).expect(400);
  });
  it('documents decimal text, nullable quantities and the quantity basis', () => {
    const doc = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(doc.paths[ROOT]).toHaveProperty('get');
    expect(doc.components?.schemas?.ShoppingListItemDto).toMatchObject({
      properties: {
        knownQuantity: { type: 'string', nullable: true },
        hasUnknownQuantity: { type: 'boolean' },
      },
    });
  });
});
