import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const ROOT = '/api/v1/meal-plan/shopping-list';
describe('Shopping list API (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: USER_ID, username: 'shopping.user' });
  });
  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: 'shopping.user',
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    prisma.mealPlanEntry.findMany.mockResolvedValue([]);
  });
  afterAll(async () => {
    await app.close();
  });
  it('requires authentication', async () => {
    await request(app.getHttpServer()).get(ROOT).expect(401);
  });
  it('returns an empty private list with the full default week and explicit quantity basis', async () => {
    const response = await request(app.getHttpServer())
      .get(ROOT)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      quantityBasis: 'RECIPE_PER_OCCURRENCE',
      items: [],
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(prisma.mealPlanEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.mealPlanEntry.deleteMany).not.toHaveBeenCalled();
  });
  it.each(['days=SUN,MON', 'days=SUN&days=MON'])(
    'accepts and orders weekday filter %s',
    async (query) => {
      const response = await request(app.getHttpServer())
        .get(`${ROOT}?${query}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
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
    await request(app.getHttpServer())
      .get(`${ROOT}?${query}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(prisma.mealPlanEntry.findMany).not.toHaveBeenCalled();
  });
  it('documents decimal text, nullable quantities and the quantity basis', () => {
    const doc = SwaggerModule.createDocument(
      app,
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
