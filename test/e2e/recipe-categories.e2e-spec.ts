import request from 'supertest';
import { type User, UserRole } from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

describe('Admin recipe categories (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let member: User;
  let adminToken: string;
  let memberToken: string;
  const server = () => e2e.app.getHttpServer();
  const URL = '/api/v1/admin/recipe-categories';

  beforeAll(async () => {
    e2e = await createE2eApp('recipe_categories_e2e');
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    member = await createUser(e2e.mongo, { username: 'vedora.member' });
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
  });

  afterAll(async () => {
    await e2e.close();
  });

  it('seeds the nine default categories in order', async () => {
    const response = await request(server())
      .get(URL)
      .query({ limit: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = response.body as {
      items: { name: string; baseTag: string; sortOrder: number }[];
      meta: { totalItems: number };
    };
    expect(body.meta.totalItems).toBe(9);
    expect(body.items[0]).toMatchObject({
      name: 'Món canh, súp',
      baseTag: 'SOUP',
    });
    expect(body.items[8]).toMatchObject({ name: 'Ăn vặt', baseTag: 'SNACK' });
  });

  it('creates, updates, rejects a duplicate name, and deletes', async () => {
    const created = await request(server())
      .post(URL)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: '  Chè  ',
        baseTag: 'DESSERT',
        icon: 'CAKE',
      })
      .expect(201);
    const category = created.body as { id: string; name: string };
    expect(created.body).toMatchObject({
      name: 'Chè',
      description: null,
      baseTag: 'DESSERT',
      icon: 'CAKE',
      sortOrder: 100,
      hidden: false,
    });

    await request(server())
      .put(`${URL}/${category.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Chè, sương sáo',
        description: 'Món ngọt mát',
        baseTag: 'DESSERT',
        hidden: true,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          name: 'Chè, sương sáo',
          description: 'Món ngọt mát',
          icon: 'UTENSILS',
          sortOrder: 100,
          hidden: true,
        });
      });

    await request(server())
      .post(URL)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Món cơm', baseTag: 'RICE' })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'NAME_TAKEN' });
      });

    await request(server())
      .delete(`${URL}/${category.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    await request(server())
      .delete(`${URL}/${category.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('reorders every category and rejects an incomplete list', async () => {
    const listOrder = async () => {
      const response = await request(server())
        .get(URL)
        .query({ limit: 50 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = response.body as {
        items: { id: string; name: string; sortOrder: number }[];
      };
      return body.items;
    };
    const before = await listOrder();
    const ids = before.map(({ id }) => id);
    const swapped = [ids[1], ids[0], ...ids.slice(2)];

    await request(server())
      .put(`${URL}/order`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: swapped })
      .expect(204);

    const after = await listOrder();
    expect(after.map(({ id }) => id)).toEqual(swapped);
    expect(after.map(({ sortOrder }) => sortOrder)).toEqual(
      swapped.map((_, index) => (index + 1) * 10),
    );

    await request(server())
      .put(`${URL}/order`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: swapped.slice(1) })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ORDER_MISMATCH' });
      });
  });

  it('rejects an unknown base tag or icon', async () => {
    await request(server())
      .post(URL)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Món Huế', baseTag: 'HUE', icon: 'ROCKET' })
      .expect(400);
  });

  it('is for admins only', async () => {
    await request(server()).get(URL).expect(401);
    await request(server())
      .get(URL)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });
});
