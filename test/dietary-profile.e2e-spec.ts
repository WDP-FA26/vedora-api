import { ConflictException, INestApplication } from '@nestjs/common';
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
import { DietaryService } from '../src/recipes/dietary.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const INGREDIENT_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const profile = {
  dietMode: 'VEGETARIAN' as const,
  allergyAcknowledgement: 'UNCONFIRMED' as const,
  version: 0,
  updatedAt: null,
  readyForMealPlanning: false,
  ingredients: [],
  groups: [],
  liked: [],
  exclusions: [],
};

describe('Dietary profile HTTP contract', () => {
  const prisma = mockDeep<PrismaService>();
  const dietary = mockDeep<DietaryService>();
  let app: INestApplication<App>;
  let token: string;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(DietaryService)
      .useValue(dietary)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: USER_ID, username: 'dietary.user' });
  });
  beforeEach(() => {
    mockReset(prisma);
    mockReset(dietary);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: 'dietary.user',
      role: UserRole.USER,
    } as never);
    dietary.find.mockResolvedValue(profile);
    dietary.patch.mockResolvedValue({ ...profile, version: 1 });
  });
  afterAll(async () => app.close());
  const authenticated = () =>
    request(app.getHttpServer())
      .patch('/api/v1/dietary/me')
      .set('Authorization', 'Bearer ' + token);

  it('requires login even for reading a dietary profile', async () => {
    await request(app.getHttpServer()).get('/api/v1/dietary/me').expect(401);
    await request(app.getHttpServer())
      .patch('/api/v1/dietary/me')
      .send({ expectedVersion: 0, dietMode: 'VEGAN' })
      .expect(401);
    expect(dietary.find).not.toHaveBeenCalled();
    expect(dietary.patch).not.toHaveBeenCalled();
  });
  it('reads only the authenticated identity and disables shared caching', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/dietary/me')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(dietary.find).toHaveBeenCalledWith(USER_ID);
    expect(response.body).toMatchObject({
      readyForMealPlanning: false,
      version: 0,
    });
  });
  it('accepts a canonical multi-reason profile update', async () => {
    const body = {
      expectedVersion: 0,
      dietMode: 'VEGAN',
      allergyAcknowledgement: 'DECLARED',
      exclusions: [
        {
          kind: 'INGREDIENT',
          target: INGREDIENT_ID,
          reasons: ['ALLERGY', 'PERSONAL'],
        },
      ],
    };
    const response = await authenticated().send(body).expect(200);
    expect(dietary.patch).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining(body),
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it.each([
    { dietMode: 'VEGAN' },
    { expectedVersion: null, dietMode: 'VEGAN' },
    { expectedVersion: '0', dietMode: 'VEGAN' },
    { expectedVersion: -1, dietMode: 'VEGAN' },
    { expectedVersion: 2147483647, dietMode: 'VEGAN' },
    { expectedVersion: 0, dietMode: null },
    { expectedVersion: 0, dietMode: 'MEAT' },
    { expectedVersion: 0, allergyAcknowledgement: null },
    { expectedVersion: 0, allergyAcknowledgement: 'YES' },
    { expectedVersion: 0, exclusions: null },
    { expectedVersion: 0, exclusions: [null] },
    {
      expectedVersion: 0,
      exclusions: [{ kind: 'INGREDIENT', target: INGREDIENT_ID, reasons: [] }],
    },
    {
      expectedVersion: 0,
      exclusions: [
        { kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY', 'ALLERGY'] },
      ],
    },
    {
      expectedVersion: 0,
      exclusions: [{ kind: 'FREE_TEXT', target: 'milk', reasons: ['ALLERGY'] }],
    },
    {
      expectedVersion: 0,
      exclusions: [
        { kind: 'ALLERGEN', target: 'MILK', reasons: ['ALLERGY'] },
        { kind: 'ALLERGEN', target: 'MILK', reasons: ['PERSONAL'] },
      ],
    },
    { expectedVersion: 0, likedIngredientIds: null },
    { expectedVersion: 0, likedIngredientIds: ['not-a-uuid'] },
    { expectedVersion: 0, likedIngredientIds: [INGREDIENT_ID, INGREDIENT_ID] },
    { expectedVersion: 0, dietMode: 'VEGAN', userId: 'another-user' },
    { expectedVersion: 0, dietMode: 'VEGAN', version: 100 },
    {
      expectedVersion: 0,
      exclusions: [
        {
          kind: 'ALLERGEN',
          target: 'MILK',
          reasons: ['ALLERGY'],
          verified: true,
        },
      ],
    },
  ])('rejects malformed, null or untrusted fields: %j', async (body) => {
    await authenticated().send(body).expect(400);
    expect(dietary.patch).not.toHaveBeenCalled();
  });
  it('preserves the version conflict code for FE recovery', async () => {
    dietary.patch.mockRejectedValue(
      new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Reload the profile',
      }),
    );
    const response = await authenticated()
      .send({ expectedVersion: 0, dietMode: 'VEGAN' })
      .expect(409);
    expect((response.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });
  it('documents the new profile endpoint and canonical enums in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(document.paths['/api/v1/dietary/me'].patch).toBeDefined();
    expect(document.components?.schemas?.PatchDietaryProfileDto).toMatchObject({
      required: ['expectedVersion'],
    });
    expect(document.components?.schemas?.DietaryExclusionDto).toMatchObject({
      required: ['kind', 'target', 'reasons'],
    });
  });
});
