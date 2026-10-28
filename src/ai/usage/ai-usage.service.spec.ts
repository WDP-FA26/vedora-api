import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../test/mongo-test-db.js';
import { MongoModule } from '../../mongo/mongo.module.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { AiFeature, AiUsage } from '../../mongo/models.js';
import { AiUsageService, bangkokDay } from './ai-usage.service.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
// 23:30 on 22 October in UTC is already 23 October in Bangkok
const NOW = new Date('2026-10-22T17:30:00Z');

describe('AiUsageService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AiUsageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('aiusage'))],
      providers: [
        AiUsageService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            BLOG_AI_DAILY_MESSAGES: 3,
            BLOG_AI_DAILY_IMAGES: 2,
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AiUsageService);
  });
  const usage = () => db.connection.model<AiUsage>(AiUsage.name);

  beforeEach(async () => {
    await usage().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  const used = (feature: AiFeature) =>
    service.summary(USER_ID, feature, NOW).then((summary) => summary.used);

  it('counts days in Asia/Bangkok', () => {
    expect(bangkokDay(NOW)).toBe('2026-10-23');
    expect(bangkokDay(new Date('2026-10-22T16:59:59Z'))).toBe('2026-10-22');
  });

  it("starts today's row on the first use and counts the following ones", async () => {
    for (let sent = 1; sent <= 2; sent++) {
      await expect(
        service.consume(USER_ID, AiFeature.BLOG_IMAGE, NOW),
      ).resolves.toBe(true);
      expect(await used(AiFeature.BLOG_IMAGE)).toBe(sent);
    }
    expect(await usage().countDocuments()).toBe(1);
  });

  it('refuses once the allowance is spent', async () => {
    for (let sent = 0; sent < 2; sent++) {
      await service.consume(USER_ID, AiFeature.BLOG_IMAGE, NOW);
    }
    await expect(
      service.consume(USER_ID, AiFeature.BLOG_IMAGE, NOW),
    ).resolves.toBe(false);
    expect(await used(AiFeature.BLOG_IMAGE)).toBe(2);
  });

  it('keeps each feature and each day apart', async () => {
    await service.consume(USER_ID, AiFeature.BLOG_IMAGE, NOW);
    expect(await used(AiFeature.BLOG_CHAT)).toBe(0);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(
      (await service.summary(USER_ID, AiFeature.BLOG_IMAGE, tomorrow)).used,
    ).toBe(0);
  });

  it('lets exactly the allowance through when requests race', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.consume(USER_ID, AiFeature.BLOG_CHAT, NOW),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await used(AiFeature.BLOG_CHAT)).toBe(3);
    expect(await usage().countDocuments()).toBe(1);
  });

  it('gives back a use on the same day, never below zero', async () => {
    await service.consume(USER_ID, AiFeature.BLOG_CHAT, NOW);
    await service.refund(USER_ID, AiFeature.BLOG_CHAT, NOW);
    await service.refund(USER_ID, AiFeature.BLOG_CHAT, NOW);
    expect(await used(AiFeature.BLOG_CHAT)).toBe(0);
  });

  it('summarises usage with the next Bangkok midnight', async () => {
    await service.consume(USER_ID, AiFeature.BLOG_CHAT, NOW);
    await service.consume(USER_ID, AiFeature.BLOG_CHAT, NOW);
    await expect(
      service.summary(USER_ID, AiFeature.BLOG_CHAT, NOW),
    ).resolves.toEqual({
      feature: AiFeature.BLOG_CHAT,
      used: 2,
      limit: 3,
      resetsAt: new Date('2026-10-23T17:00:00Z'),
    });
  });

  it('reports nothing used on a fresh day', async () => {
    expect(
      await service.summary(USER_ID, AiFeature.BLOG_IMAGE, NOW),
    ).toMatchObject({ used: 0, limit: 2 });
  });
});
