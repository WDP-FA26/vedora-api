import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';
import { PostEvidenceService } from '../../../src/media/post-evidence.service.js';
import { PostModerationService } from '../../../src/media/post-moderation.service.js';
import { ConfigService } from '@nestjs/config';
import { ContentEvidenceService } from '../../../src/moderation/content-evidence.service.js';
import { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import {
  type ModerationEvidence,
  type Post,
  PostStatus,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';

const ready: ModerationEvidence = {
  status: 'READY',
  decision: 'reject',
  category: 'violence',
  summary: 'Có lời đe dọa.',
  items: [
    {
      field: 'body',
      category: 'violence',
      reason: 'Đe dọa',
      quote: 'giết',
      start: 4,
      end: 8,
      mediaId: null,
      seconds: null,
      imageUrl: null,
      box: null,
    },
  ],
  dropped: 0,
  model: 'test/explainer',
  createdAt: new Date('2026-11-19T00:00:00Z'),
};

describe('PostEvidenceService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostEvidenceService;
  let authorId: string;
  const flagged = new Subject<string>();
  const evidenceSources = vi.fn();
  const explain = vi.fn();
  const finishReview = vi.fn();
  const posts = () => db.connection.model<Post>('Post');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postevidence'))],
      providers: [
        PostEvidenceService,
        {
          provide: PostModerationService,
          useValue: { flagged, evidenceSources, finishReview },
        },
        { provide: ContentEvidenceService, useValue: { explain } },
        {
          provide: ModerationSettingsService,
          useValue: {
            get: () => Promise.resolve({ manipulationThreshold: 0.5 }),
          },
        },
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostEvidenceService);
    authorId = (await createUser(db)).id;
  });

  beforeEach(async () => {
    await posts().deleteMany({});
    evidenceSources.mockReset();
    evidenceSources.mockResolvedValue({ texts: [], images: [] });
    finishReview.mockReset();
    finishReview.mockResolvedValue(true);
    explain.mockReset();
    explain.mockImplementation(async (load: () => Promise<unknown>) => {
      await load();
      return ready;
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  function flaggedPost(status: PostStatus) {
    return createPost(db, {
      authorId,
      status,
      publishedAt: null,
      body: 'Tao giết mày',
      moderation: {
        verdict: 'violence',
        violationScore: 0.9,
        scores: { violence: 0.9 },
        checkedAt: new Date('2026-11-19T01:00:00Z'),
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
  }

  it('stores evidence on a post held for review', async () => {
    const post = await flaggedPost(PostStatus.PENDING_REVIEW);

    await expect(service.explain(post.id)).resolves.toBe(true);

    const stored = await posts().findById(post.id).lean().exec();
    expect(stored?.moderation?.verdict).toBe('violence');
    expect(stored?.moderation?.evidence).toMatchObject({
      status: 'READY',
      summary: 'Có lời đe dọa.',
      items: [{ field: 'body', start: 4, end: 8 }],
    });
  });

  it('reads the sources of the post it explains', async () => {
    const post = await flaggedPost(PostStatus.PENDING_REVIEW);

    await service.explain(post.id);

    expect(evidenceSources).toHaveBeenCalledWith(
      expect.objectContaining({ id: post.id }),
    );
  });

  it('leaves published posts alone without calling the model', async () => {
    const post = await flaggedPost(PostStatus.PUBLISHED);

    await expect(service.explain(post.id)).resolves.toBe(false);
    expect(explain).not.toHaveBeenCalled();
  });

  it('drops evidence for a verdict that was replaced while the model read it', async () => {
    const post = await flaggedPost(PostStatus.REJECTED);
    explain.mockImplementation(async () => {
      await posts()
        .updateOne(
          { _id: post.id },
          {
            $set: { 'moderation.checkedAt': new Date('2026-11-19T02:00:00Z') },
          },
        )
        .exec();
      return ready;
    });

    await expect(service.explain(post.id)).resolves.toBe(false);
    const stored = await posts().findById(post.id).lean().exec();
    expect(stored?.moderation?.evidence ?? null).toBeNull();
  });

  it('explains posts the classifier flags, one after another', async () => {
    const post = await flaggedPost(PostStatus.PENDING_REVIEW);

    flagged.next(post.id);

    await vi.waitFor(async () => {
      const stored = await posts().findById(post.id).lean().exec();
      expect(stored?.moderation?.evidence?.status).toBe('READY');
    });
  });

  it('applies the router outcome to a post held for the reviewer', async () => {
    const post = await createPost(db, {
      authorId,
      status: PostStatus.PROCESSING,
      publishedAt: null,
      body: 'Tao giết mày',
      moderation: {
        verdict: 'violence',
        violationScore: 0.6,
        scores: { violence: 0.6, allow: 0.4 },
        checkedAt: new Date('2026-11-19T01:00:00Z'),
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        heldAt: new Date('2026-11-19T01:00:00Z'),
      },
    });

    await expect(service.explain(post.id)).resolves.toBe(true);

    expect(finishReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: post.id }),
      ready,
      { outcome: 'REJECT', rule: 'REVIEWER_REJECT', category: 'violence' },
    );
  });

  it('only records the outcome on a post already decided, keeping an applied one', async () => {
    const post = await flaggedPost(PostStatus.REJECTED);

    await service.explain(post.id);
    const recorded = await posts().findById(post.id).lean().exec();
    expect(recorded?.moderation?.route).toMatchObject({
      outcome: 'REJECT',
      rule: 'REVIEWER_REJECT',
      appliedBy: null,
    });
    expect(finishReview).not.toHaveBeenCalled();

    await posts()
      .updateOne(
        { _id: post.id },
        {
          $set: {
            'moderation.route.appliedBy': 'SYSTEM_TWO',
            'moderation.route.rule': 'REVIEWER_ACCEPT',
          },
        },
      )
      .exec();
    await service.explain(post.id);
    const kept = await posts().findById(post.id).lean().exec();
    expect(kept?.moderation?.route).toMatchObject({
      rule: 'REVIEWER_ACCEPT',
      appliedBy: 'SYSTEM_TWO',
    });
  });

  it('requeues held posts whose review was lost', async () => {
    const post = await createPost(db, {
      authorId,
      status: PostStatus.PROCESSING,
      publishedAt: null,
      body: 'Tao giết mày',
      moderation: {
        verdict: 'violence',
        violationScore: 0.6,
        scores: { violence: 0.6, allow: 0.4 },
        checkedAt: new Date('2026-11-19T01:00:00Z'),
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        heldAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    await service.retryHeld();

    await vi.waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0][0]).toMatchObject({ id: post.id });
  });
});
