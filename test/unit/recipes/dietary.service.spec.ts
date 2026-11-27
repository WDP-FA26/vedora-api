import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ActivityLevel,
  BiologicalSex,
  BmiCategory,
  BodyFeeling,
  type IngredientGroup,
  NutritionGoal,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { DietaryService } from '@src/recipes/dietary.service.js';
import { createIngredient, createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const GARLIC_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const ONION_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const ALLIUM_GROUP = 'b1a2d3e4-0000-4000-8000-000000000001';
const HIDDEN_GROUP = 'b1a2d3e4-0000-4000-8000-000000000002';

describe('DietaryService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: DietaryService;

  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('dietary'))],
      providers: [DietaryService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(DietaryService);
  });

  beforeEach(async () => {
    for (const collection of [
      'ingredients',
      'ingredient_groups',
      'body_metric_logs',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'dietary.user' });
    await createIngredient(mongo, {
      id: TOFU_ID,
      name: 'Đậu hũ',
      aliases: ['Tofu'],
    });
    await createIngredient(mongo, { id: GARLIC_ID, name: 'Tỏi' });
    await createIngredient(mongo, { id: ONION_ID, name: 'Hành' });
    await groups().create({
      _id: ALLIUM_GROUP,
      name: 'Ngũ vị tân',
      dietary: true,
      ingredientIds: [GARLIC_ID, ONION_ID],
    });
    await groups().create({
      _id: HIDDEN_GROUP,
      name: 'Nhóm nội bộ',
      dietary: false,
      ingredientIds: [TOFU_ID],
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('returns empty lists when the user does not exist', async () => {
    await expect(
      service.find('4a1e32e4-e18e-4dd7-8b4a-246ef2113fff'),
    ).resolves.toEqual({ allergies: [], preferences: [] });
  });

  it('replaces only the lists that are sent', async () => {
    const saved = await service.replace(USER_ID, {
      allergies: ['Dị ứng đậu phộng', 'Kiêng ăn cay'],
      preferences: ['Không thích nấm'],
    });
    expect(saved).toEqual({
      allergies: ['Dị ứng đậu phộng', 'Kiêng ăn cay'],
      preferences: ['Không thích nấm'],
    });

    const kept = await service.replace(USER_ID, { preferences: [] });
    expect(kept).toEqual({
      allergies: ['Dị ứng đậu phộng', 'Kiêng ăn cay'],
      preferences: [],
    });
    await expect(service.find(USER_ID)).resolves.toEqual(kept);
  });

  it('adds and removes memory lines without touching the other section', async () => {
    await service.replace(USER_ID, {
      allergies: ['Dị ứng đậu phộng'],
      preferences: ['Không thích nấm'],
    });

    await expect(
      service.updateMemory(USER_ID, 'allergies', {
        add: ['  Dị ứng mè ', 'Dị ứng đậu phộng', ''],
      }),
    ).resolves.toEqual(['Dị ứng đậu phộng', 'Dị ứng mè']);

    await expect(
      service.updateMemory(USER_ID, 'preferences', {
        remove: ['Không thích nấm', 'Không có dòng này'],
        add: ['Chỉ nấu bữa tối'],
      }),
    ).resolves.toEqual(['Chỉ nấu bữa tối']);

    await expect(service.find(USER_ID)).resolves.toEqual({
      allergies: ['Dị ứng đậu phộng', 'Dị ứng mè'],
      preferences: ['Chỉ nấu bữa tối'],
    });
  });

  it('refuses to grow a section past its limit', async () => {
    const full = Array.from({ length: 30 }, (_, index) => `Dòng ${index}`);
    await service.replace(USER_ID, { preferences: full });

    await expect(
      service.updateMemory(USER_ID, 'preferences', { add: ['Dòng mới'] }),
    ).rejects.toMatchObject({ code: 'DIETARY_MEMORY_FULL' });
  });

  it('turns legacy notes and avoided ids into lines on first read', async () => {
    await mongo.connection.collection('users').updateOne(
      { _id: USER_ID },
      {
        $set: {
          allergyNote: '- Dị ứng đậu phộng\n\nKiêng ăn cay',
          preferenceNote: 'Không thích nấm',
          avoidedIngredientIds: [TOFU_ID],
          avoidedGroupIds: [ALLIUM_GROUP],
        },
        $unset: { allergies: '', foodPreferences: '' },
      },
    );

    await expect(service.find(USER_ID)).resolves.toEqual({
      allergies: [
        'Dị ứng đậu phộng',
        'Kiêng ăn cay',
        'Không ăn: nhóm Ngũ vị tân, Đậu hũ',
      ],
      preferences: ['Không thích nấm'],
    });

    const stored = await mongo.connection
      .collection('users')
      .findOne({ username: 'dietary.user' });
    expect(stored).not.toHaveProperty('allergyNote');
    expect(stored).not.toHaveProperty('preferenceNote');
    expect(stored).not.toHaveProperty('avoidedIngredientIds');
    expect(stored).not.toHaveProperty('avoidedGroupIds');
    expect(stored?.allergies).toHaveLength(3);
  });

  it('extracts allergen keywords from the allergy lines', async () => {
    await service.replace(USER_ID, {
      allergies: ['Dị ứng đậu nành'],
      preferences: ['Không thích nấm'],
    });

    const keywords = await service.allergyKeywords(USER_ID);
    expect(keywords).toContain('đậu hũ');
    expect(keywords).not.toContain('nấm');
  });

  it('saves nutrition profile, logs weight check-ins by date, and refuses unsafe underweight loss goals', async () => {
    const saved = await service.saveNutrition(USER_ID, {
      heightCm: 165,
      weightKg: 64,
      targetWeightKg: 57,
      birthYear: 1998,
      biologicalSex: BiologicalSex.FEMALE,
      activityLevel: ActivityLevel.LIGHT,
      nutritionGoal: NutritionGoal.LOSE_WEIGHT,
      feeling: BodyFeeling.ENERGETIC,
    });

    expect(saved.bmi).toBe(23.5);
    expect(saved.bmiCategory).toBe(BmiCategory.OVERWEIGHT);
    expect(saved.dailyCalorieTarget).toBeGreaterThanOrEqual(1200);
    expect(saved.history).toHaveLength(1);
    expect(saved.history[0]).toMatchObject({
      weightKg: 64,
      heightCm: 165,
      bmi: 23.5,
      feeling: BodyFeeling.ENERGETIC,
    });

    const pastCheckIn = await service.checkInWeight(USER_ID, {
      weightKg: 65.2,
      date: '2026-11-10',
      feeling: BodyFeeling.TIRED,
      note: 'Bắt đầu theo dõi',
    });
    expect(pastCheckIn.history).toHaveLength(2);
    expect(pastCheckIn.history.map((item) => item.date)).toEqual([
      '2026-11-10',
      saved.history[0].date,
    ]);
    expect(pastCheckIn.weightKg).toBe(64);

    const sameDayUpdate = await service.checkInWeight(USER_ID, {
      weightKg: 63.4,
      feeling: BodyFeeling.NORMAL,
    });
    expect(sameDayUpdate.history).toHaveLength(2);
    expect(sameDayUpdate.weightKg).toBe(63.4);

    await expect(
      service.saveNutrition(USER_ID, {
        heightCm: 165,
        targetWeightKg: 45,
        nutritionGoal: NutritionGoal.LOSE_WEIGHT,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TARGET_WEIGHT' });
  });
});
