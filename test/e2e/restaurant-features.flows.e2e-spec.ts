import { randomUUID } from 'node:crypto';
import { AiService } from '@nestjs/ai';
import request from 'supertest';
import { z } from 'zod';
import {
  AccountType,
  User,
  UserRole,
  Workspace,
  WorkspaceMember,
  WorkspaceProof,
  RestaurantMenuItem,
  RestaurantReview,
} from '@src/mongo/models.js';
import { RefreshTokensService } from '@src/auth/refresh-tokens.service.js';
import { QdrantService } from '@src/qdrant/qdrant.service.js';
import { StorageService } from '@src/storage/storage.service.js';
import { MenuSearchIndexService } from '@src/workspaces/search/menu-search-index.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import {
  APPROVE_REVIEW,
  PAGE_APPLICATION,
  uploadedProofs,
} from '@test/support/workspace-application.js';
import { createUser } from '@test/support/fixtures.js';

const errorSchema = z.object({ statusCode: z.number(), code: z.string() });
const restaurantPinSchema = z.object({
  pageUserId: z.string(),
  username: z.string(),
  name: z.string(),
  distanceMeters: z.number().nullable(),
  averageRating: z.number().nullable(),
  reviewCount: z.number(),
});
const restaurantListSchema = z.object({
  items: z.array(restaurantPinSchema),
  truncated: z.boolean(),
});
const menuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  priceVnd: z.number().nullable(),
  isAvailable: z.boolean(),
});
const menuSearchPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      restaurant: z.object({
        pageUserId: z.string(),
        name: z.string(),
        averageRating: z.number().nullable(),
        reviewCount: z.number(),
      }),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const reviewPageSchema = z.object({
  summary: z.object({
    averageRating: z.number().nullable(),
    reviewCount: z.number(),
    breakdown: z.object({
      '1': z.number(),
      '2': z.number(),
      '3': z.number(),
      '4': z.number(),
      '5': z.number(),
    }),
  }),
  myReview: z
    .object({
      id: z.string(),
      rating: z.number(),
      comment: z.string().nullable(),
    })
    .nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      rating: z.number(),
      comment: z.string().nullable(),
      author: z.object({ id: z.string(), username: z.string() }),
    }),
  ),
});

function deterministicVector(text: string, dims = 768): number[] {
  const vec = new Array<number>(dims).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    vec[i % dims] += (lower.charCodeAt(i) % 31) / 31;
  }
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}

vi.setConfig({ testTimeout: 30_000 });

describe('Restaurant proximity, menu search & reviews (e2e)', () => {
  let e2e: E2eApp;
  let owner: User;
  let manager: User;
  let diner1: User;
  let diner2: User;
  let admin: User;
  let ownerToken: string;
  let managerToken: string;
  let diner1Token: string;
  let diner2Token: string;
  let adminToken: string;
  let testCollection: string;

  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  async function createApprovedRestaurant(input: {
    name: string;
    username: string;
    address: string;
    longitude: number;
    latitude: number;
  }) {
    const proofIds = await uploadedProofs(e2e.mongo, owner.id);
    const created = await request(server())
      .post('/api/v1/workspaces')
      .auth(ownerToken, { type: 'bearer' })
      .send({ ...PAGE_APPLICATION, ...input, proofIds })
      .expect(201);
    const workspaceId = z.object({ id: z.string() }).parse(created.body).id;
    const reviewed = await request(server())
      .post(`/api/v1/admin/workspaces/${workspaceId}/review`)
      .auth(adminToken, { type: 'bearer' })
      .send(APPROVE_REVIEW)
      .expect(200);
    const pageUserId = z
      .object({ pageUserId: z.string() })
      .parse(reviewed.body).pageUserId;
    return { workspaceId, pageUserId };
  }

  beforeAll(async () => {
    testCollection = `vedora_menu_test_${randomUUID().replaceAll('-', '')}`;
    process.env.QDRANT_MENU_ITEMS_COLLECTION = testCollection;

    e2e = await createE2eApp('restaurant_features_e2e');
    const storage = e2e.app.get(StorageService);
    vi.spyOn(storage, 'exists').mockResolvedValue(true);
    vi.spyOn(storage, 'presignUpload').mockResolvedValue({
      url: 'http://localhost:9000/vedora-blogs/put',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const ai = e2e.app.get(AiService);
    vi.spyOn(ai, 'embed').mockImplementation(
      ({ value }: { value: string }) =>
        Promise.resolve({
          embedding: deterministicVector(value),
          usage: { tokens: 1 },
        }) as ReturnType<AiService['embed']>,
    );
    vi.spyOn(ai, 'embedMany').mockImplementation(
      ({ values }: { values: string[] }) =>
        Promise.resolve({
          embeddings: values.map((v) => deterministicVector(v)),
          usage: { tokens: values.length },
        }) as ReturnType<AiService['embedMany']>,
    );
  });

  beforeEach(async () => {
    for (const name of [
      User.name,
      Workspace.name,
      WorkspaceMember.name,
      WorkspaceProof.name,
      RestaurantMenuItem.name,
      RestaurantReview.name,
    ]) {
      await model(name).deleteMany({});
    }

    owner = await createUser(e2e.mongo, { username: 'rest.owner' });
    manager = await createUser(e2e.mongo, { username: 'rest.manager' });
    diner1 = await createUser(e2e.mongo, { username: 'diner.one' });
    diner2 = await createUser(e2e.mongo, { username: 'diner.two' });
    admin = await createUser(e2e.mongo, {
      username: 'rest.admin',
      role: UserRole.ADMIN,
    });
    [ownerToken, managerToken, diner1Token, diner2Token, adminToken] =
      await Promise.all([
        e2e.sign(owner),
        e2e.sign(manager),
        e2e.sign(diner1),
        e2e.sign(diner2),
        e2e.sign(admin),
      ]);
  });

  afterAll(async () => {
    try {
      const qdrant = e2e.app.get(QdrantService);
      if ((await qdrant.collectionExists(testCollection)).exists) {
        await qdrant.deleteCollection(testCollection);
      }
    } catch {}
    vi.restoreAllMocks();
    await e2e.close();
  });

  it('sorts restaurants nearest-first when user coordinates are provided and A-Z otherwise', async () => {
    const hoanKiem = await createApprovedRestaurant({
      name: 'Chay Hoàn Kiếm',
      username: 'chay.hoan.kiem',
      address: '12 Hàng Bông, Hoàn Kiếm, Hà Nội',
      longitude: 105.8542,
      latitude: 21.0285,
    });
    const cauGiay = await createApprovedRestaurant({
      name: 'Chay Cầu Giấy',
      username: 'chay.cau.giay',
      address: '88 Cầu Giấy, Hà Nội',
      longitude: 105.79,
      latitude: 21.036,
    });
    const saigonDauHu = await createApprovedRestaurant({
      name: 'Đậu Hũ Sài Gòn',
      username: 'dau.hu.sai.gon',
      address: '10 Lê Lợi, Quận 1, TP.HCM',
      longitude: 106.7009,
      latitude: 10.7769,
    });
    const saigonAnLac = await createApprovedRestaurant({
      name: 'An Lạc',
      username: 'an.lac.sg',
      address: '20 Nguyễn Huệ, Quận 1, TP.HCM',
      longitude: 106.703,
      latitude: 10.774,
    });

    const alphabeticalRes = await request(server())
      .get('/api/v1/restaurants')
      .expect(200);
    const alphabetical = restaurantListSchema.parse(alphabeticalRes.body);
    expect(alphabetical.items.map((item) => item.pageUserId)).toEqual([
      saigonAnLac.pageUserId,
      cauGiay.pageUserId,
      hoanKiem.pageUserId,
      saigonDauHu.pageUserId,
    ]);
    expect(
      alphabetical.items.every((item) => item.distanceMeters === null),
    ).toBe(true);

    const nearestAllRes = await request(server())
      .get('/api/v1/restaurants')
      .query({ userLng: 105.791, userLat: 21.035 })
      .expect(200);
    const nearestAll = restaurantListSchema.parse(nearestAllRes.body);
    expect(nearestAll.items).toHaveLength(4);
    expect(nearestAll.items[0].pageUserId).toBe(cauGiay.pageUserId);
    expect(nearestAll.items[1].pageUserId).toBe(hoanKiem.pageUserId);
    expect(nearestAll.items[0].distanceMeters).toBeLessThan(1000);
    expect(nearestAll.items[1].distanceMeters).toBeGreaterThan(5000);
    expect(
      nearestAll.items.every((item) => typeof item.distanceMeters === 'number'),
    ).toBe(true);

    const sortedRes = await request(server())
      .get('/api/v1/restaurants')
      .query({
        minLng: 105.7,
        minLat: 20.9,
        maxLng: 106.0,
        maxLat: 21.2,
        userLng: 105.791,
        userLat: 21.035,
      })
      .expect(200);
    const sorted = restaurantListSchema.parse(sortedRes.body);
    expect(sorted.items).toHaveLength(2);
    expect(sorted.items[0].pageUserId).toBe(cauGiay.pageUserId);
    expect(sorted.items[1].pageUserId).toBe(hoanKiem.pageUserId);
    expect(sorted.items[0].distanceMeters).toBeLessThan(1000);
    expect(sorted.items[1].distanceMeters).toBeGreaterThan(5000);

    const plainRes = await request(server())
      .get('/api/v1/restaurants')
      .query({ minLng: 105.7, minLat: 20.9, maxLng: 106.0, maxLat: 21.2 })
      .expect(200);
    const plain = restaurantListSchema.parse(plainRes.body);
    expect(plain.items.map((item) => item.pageUserId)).toEqual([
      cauGiay.pageUserId,
      hoanKiem.pageUserId,
    ]);
    expect(plain.items.every((item) => item.distanceMeters === null)).toBe(
      true,
    );

    await request(server())
      .get('/api/v1/restaurants')
      .query({
        minLng: 105.7,
        minLat: 20.9,
        maxLng: 106.0,
        maxLat: 21.2,
        userLng: 105.8,
      })
      .expect(400);
  });

  it('manages menu items, indexes them in Qdrant, and supports accented & unaccented search', async () => {
    const { workspaceId, pageUserId } = await createApprovedRestaurant({
      name: 'Bếp Chay Sen Vàng',
      username: 'bep.sen.vang',
      address: '25 Tràng Tiền, Hoàn Kiếm, Hà Nội',
      longitude: 105.857,
      latitude: 21.024,
    });

    await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ username: manager.username })
      .expect(201);

    await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/menu`)
      .auth(ownerToken, { type: 'bearer' })
      .send({
        name: 'Phở nấm hương',
        imageUrl: 'https://evil.example/pho.jpg',
      })
      .expect(400);

    await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/menu`)
      .auth(diner1Token, { type: 'bearer' })
      .send({ name: 'Món lạ' })
      .expect(404);

    const uploadRes = await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/menu/image-uploads`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ contentType: 'image/jpeg', sizeBytes: 12000 })
      .expect(201);
    const imageUrl = z.object({ url: z.string() }).parse(uploadRes.body).url;

    const createdRes = await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/menu`)
      .auth(ownerToken, { type: 'bearer' })
      .send({
        name: 'Phở nấm hương đặc biệt',
        category: 'Món nước',
        priceVnd: 55000,
        description: 'Nước dùng rau củ ngọt thanh cùng nấm đông cô.',
        imageUrl,
      })
      .expect(201);
    const pho = menuItemSchema.parse(createdRes.body);

    const lauRes = await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/menu`)
      .auth(managerToken, { type: 'bearer' })
      .send({
        name: 'Lẩu thái chay',
        category: 'Lẩu',
        priceVnd: 199000,
      })
      .expect(201);
    const lau = menuItemSchema.parse(lauRes.body);

    const publicMenuRes = await request(server())
      .get(`/api/v1/restaurants/${pageUserId}/menu`)
      .expect(200);
    expect(
      z.object({ items: z.array(menuItemSchema) }).parse(publicMenuRes.body)
        .items,
    ).toHaveLength(2);

    await e2e.app.get(MenuSearchIndexService).drain();

    const searchAccented = menuSearchPageSchema.parse(
      (
        await request(server())
          .get('/api/v1/restaurants/menu/search')
          .query({ q: 'Phở nấm' })
          .expect(200)
      ).body,
    );
    expect(searchAccented.items.some((item) => item.id === pho.id)).toBe(true);

    const searchFolded = menuSearchPageSchema.parse(
      (
        await request(server())
          .get('/api/v1/restaurants/menu/search')
          .query({ q: 'lau thai' })
          .expect(200)
      ).body,
    );
    expect(searchFolded.items[0]).toMatchObject({
      id: lau.id,
      restaurant: { pageUserId, name: 'Bếp Chay Sen Vàng' },
    });

    await request(server())
      .patch(`/api/v1/workspaces/${workspaceId}/menu/${lau.id}`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ isAvailable: false })
      .expect(200);

    const afterHide = menuSearchPageSchema.parse(
      (
        await request(server())
          .get('/api/v1/restaurants/menu/search')
          .query({ q: 'lau thai' })
          .expect(200)
      ).body,
    );
    expect(afterHide.items.some((item) => item.id === lau.id)).toBe(false);

    await request(server())
      .delete(`/api/v1/workspaces/${workspaceId}/menu/${pho.id}`)
      .auth(ownerToken, { type: 'bearer' })
      .expect(204);

    const remainingMenu = await request(server())
      .get(`/api/v1/restaurants/${pageUserId}/menu`)
      .expect(200);
    expect(
      z.object({ items: z.array(menuItemSchema) }).parse(remainingMenu.body)
        .items,
    ).toHaveLength(1);
  });

  it('supports Google Maps-style star reviews, prevents self/page reviews, and propagates ratings', async () => {
    const { workspaceId, pageUserId } = await createApprovedRestaurant({
      name: 'Quán Chay Bình An',
      username: 'chay.binh.an',
      address: '5 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội',
      longitude: 105.855,
      latitude: 21.023,
    });
    await request(server())
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ username: manager.username })
      .expect(201);

    const selfOwner = await request(server())
      .put(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ rating: 5, comment: 'Tự khen' })
      .expect(403);
    expect(errorSchema.parse(selfOwner.body).code).toBe(
      'SELF_RATING_NOT_ALLOWED',
    );

    const selfManager = await request(server())
      .put(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(managerToken, { type: 'bearer' })
      .send({ rating: 5 })
      .expect(403);
    expect(errorSchema.parse(selfManager.body).code).toBe(
      'SELF_RATING_NOT_ALLOWED',
    );

    const refreshIssued = await e2e.app
      .get(RefreshTokensService)
      .issue(owner.id);
    const switched = await request(server())
      .post('/api/v1/auth/switch')
      .auth(ownerToken, { type: 'bearer' })
      .send({ refreshToken: refreshIssued.token, pageId: pageUserId })
      .expect(200);
    const pageToken = z
      .object({
        accessToken: z.string(),
        user: z.object({ accountType: z.literal(AccountType.PAGE) }),
      })
      .parse(switched.body).accessToken;

    const pageAttempt = await request(server())
      .put(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(pageToken, { type: 'bearer' })
      .send({ rating: 5 })
      .expect(403);
    expect(errorSchema.parse(pageAttempt.body).code).toBe(
      'PAGE_SESSION_NOT_ALLOWED',
    );

    await request(server())
      .put(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(diner1Token, { type: 'bearer' })
      .send({ rating: 5, comment: 'Món rất ngon và sạch sẽ!' })
      .expect(200);

    await request(server())
      .put(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(diner2Token, { type: 'bearer' })
      .send({ rating: 3, comment: 'Ổn, hơi đông buổi trưa.' })
      .expect(200);

    const highest = reviewPageSchema.parse(
      (
        await request(server())
          .get(`/api/v1/restaurants/${pageUserId}/reviews`)
          .auth(diner1Token, { type: 'bearer' })
          .query({ sort: 'highest' })
          .expect(200)
      ).body,
    );
    expect(highest.summary).toEqual({
      averageRating: 4,
      reviewCount: 2,
      breakdown: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1 },
    });
    expect(highest.myReview).toMatchObject({ rating: 5 });
    expect(highest.items[0].rating).toBe(5);
    expect(highest.items[1].rating).toBe(3);

    const lowest = reviewPageSchema.parse(
      (
        await request(server())
          .get(`/api/v1/restaurants/${pageUserId}/reviews`)
          .query({ sort: 'lowest' })
          .expect(200)
      ).body,
    );
    expect(lowest.myReview).toBeNull();
    expect(lowest.items[0].rating).toBe(3);

    const profileRes = await request(server())
      .get(`/api/v1/profiles/${pageUserId}`)
      .expect(200);
    expect(profileRes.body).toMatchObject({
      restaurant: {
        workspaceId,
        averageRating: 4,
        reviewCount: 2,
      },
    });

    const pins = restaurantListSchema.parse(
      (
        await request(server())
          .get('/api/v1/restaurants')
          .query({ minLng: 105.7, minLat: 20.9, maxLng: 106.0, maxLat: 21.2 })
          .expect(200)
      ).body,
    );
    expect(pins.items[0]).toMatchObject({
      pageUserId,
      averageRating: 4,
      reviewCount: 2,
    });

    const deletedSummary = await request(server())
      .delete(`/api/v1/restaurants/${pageUserId}/reviews/me`)
      .auth(diner1Token, { type: 'bearer' })
      .expect(200);
    expect(deletedSummary.body).toEqual({
      averageRating: 3,
      reviewCount: 1,
      breakdown: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 0 },
    });
  });
});
