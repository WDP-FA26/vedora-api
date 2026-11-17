import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { KnowledgeMaintenanceService } from '../../src/knowledge/knowledge-maintenance.service.js';
import { KnowledgeService } from '../../src/knowledge/knowledge.service.js';
import { PdfExtractor } from '../../src/knowledge/extractors/pdf-extractor.js';
import type { ExtractedSection } from '../../src/knowledge/extractors/document-extractor.js';
import { KnowledgeIndexService } from '../../src/knowledge/retrieval/knowledge-index.service.js';
import { KnowledgeModelsService } from '../../src/knowledge/retrieval/knowledge-models.service.js';
import { KnowledgeSearchService } from '../../src/knowledge/retrieval/knowledge-search.service.js';
import {
  type KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  type KnowledgePage,
  type User,
  UserRole,
} from '../../src/mongo/models.js';
import { QdrantService } from '../../src/qdrant/qdrant.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

/**
 * Black-box flows of the admin knowledge base: upload → OCR → review →
 * approve/reject → index → delete. Real MongoDB and a real local Qdrant
 * (a collection of its own per run); only S3, OCR and OpenRouter embeddings
 * are stubbed at their boundary.
 */

// ConfigModule validates the environment when AppModule is imported, so the
// collection and vector size must be set before any import runs.
const COLLECTION = vi.hoisted(() => {
  const name = `knowledge_flows_${crypto.randomUUID().replaceAll('-', '')}`;
  process.env.QDRANT_COLLECTION = name;
  process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS = '4';
  return name;
});
const MB = 1024 * 1024;
const STALE_MS = 16 * 60 * 1000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function section(text: string): ExtractedSection {
  return { text, images: [], flags: [] };
}

const CALCIUM_PAGES = [
  '# Canxi\n\nĐậu phụ giàu canxi, khoảng 350 mg mỗi 100 g.',
  'Rau cải xoăn cũng cung cấp canxi.',
];

describe('Knowledge base flows (HTTP + MongoDB + Qdrant)', () => {
  let e2e: E2eApp;
  let admin: User;
  let adminToken: string;
  let memberToken: string;
  let storage: StorageService;
  let pdf: PdfExtractor;
  let models: KnowledgeModelsService;
  let qdrant: QdrantService;
  let knowledge: KnowledgeService;
  let maintenance: KnowledgeMaintenanceService;
  let embedGate: Deferred<void> | null;
  let extractGate: Deferred<void> | null;
  let extractedPages: string[];

  const http = () => request(e2e.app.getHttpServer());
  const route = '/api/v1/knowledge/documents';
  const documents = () =>
    e2e.connection.model<KnowledgeDocument>('KnowledgeDocument');
  const pages = () => e2e.connection.model<KnowledgePage>('KnowledgePage');
  const statusOf = async (id: string) =>
    (await documents().findById(id).exec())?.status ?? null;

  const pointCount = async (documentId: string): Promise<number> => {
    const { exists } = await qdrant.collectionExists(COLLECTION);
    if (!exists) return 0;
    const { count } = await qdrant.count(COLLECTION, {
      exact: true,
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    });
    return count;
  };

  /** Creates a document over HTTP and returns its id and storage key. */
  const startUpload = async (filename = 'dinh-duong.pdf') => {
    const response = await http()
      .post(route)
      .auth(adminToken, { type: 'bearer' })
      .send({ filename, sizeBytes: 2048 })
      .expect(201);
    const body = response.body as { document: { id: string } };
    const document = await documents().findById(body.document.id).exec();
    if (!document) throw new Error('document was not stored');
    return { id: document.id, storageKey: document.storageKey };
  };

  /** Simulates the RustFS upload event and waits for the OCR step to finish. */
  const uploadAndExtract = async (texts: string[] = CALCIUM_PAGES) => {
    extractedPages = texts;
    const document = await startUpload();
    await knowledge.markUploaded(document.storageKey);
    await vi.waitFor(async () =>
      expect(await statusOf(document.id)).toBe(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      ),
    );
    return document;
  };

  const approve = (id: string, body: object = {}) =>
    http()
      .post(`${route}/${id}/approve`)
      .auth(adminToken, { type: 'bearer' })
      .send(body);

  const waitForStatus = (id: string, status: KnowledgeDocumentStatus) =>
    vi.waitFor(async () => expect(await statusOf(id)).toBe(status), {
      timeout: 10_000,
    });

  /** Calls through, so a test can await the background run it starts. */
  const watchBackgroundRuns = (method: 'ingest' | 'indexApproved') =>
    vi.spyOn(knowledge, method);
  const allSettled = async (
    runs: ReturnType<typeof watchBackgroundRuns>,
  ): Promise<void> => {
    for (const { value } of runs.mock.results) await value;
  };

  const backdate = (id: string) =>
    documents().collection.updateOne(
      { _id: id },
      { $set: { updatedAt: new Date(Date.now() - STALE_MS) } },
    );

  beforeAll(async () => {
    e2e = await createE2eApp('knowledge_flows');
    storage = e2e.app.get(StorageService);
    pdf = e2e.app.get(PdfExtractor);
    models = e2e.app.get(KnowledgeModelsService);
    qdrant = e2e.app.get(QdrantService);
    knowledge = e2e.app.get(KnowledgeService);
    maintenance = e2e.app.get(KnowledgeMaintenanceService);
    // Never write into a developer's real collection.
    if (e2e.app.get(KnowledgeIndexService).collection !== COLLECTION) {
      throw new Error('QDRANT_COLLECTION was not isolated for this spec');
    }
    if (models.dimensions !== 4) {
      throw new Error('KNOWLEDGE_EMBEDDING_DIMENSIONS was not applied');
    }
    admin = await createUser(e2e.mongo, {
      username: 'knowledge.admin',
      role: UserRole.ADMIN,
    });
    adminToken = await e2e.sign(admin);
    const member = await createUser(e2e.mongo, { username: 'member' });
    memberToken = await e2e.sign(member);
  });

  beforeEach(() => {
    embedGate = null;
    extractGate = null;
    extractedPages = CALCIUM_PAGES;
    vi.spyOn(storage, 'presignUpload').mockImplementation(
      (_target, key, contentType) =>
        Promise.resolve({
          url: `https://storage.test/${key}?X-Amz-Signature=s`,
          method: 'PUT',
          headers: { 'content-type': contentType },
          expiresAt: new Date(Date.now() + 3600_000),
        }),
    );
    vi.spyOn(storage, 'presignDownload').mockImplementation((_target, key) =>
      Promise.resolve(`https://storage.test/${key}?download`),
    );
    vi.spyOn(storage, 'getBytes').mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(storage, 'delete').mockResolvedValue();
    vi.spyOn(pdf, 'extract').mockImplementation(async () => {
      if (extractGate) await extractGate.promise;
      return extractedPages.map(section);
    });
    vi.spyOn(pdf, 'extractImages').mockImplementation(() =>
      Promise.resolve(extractedPages.map(() => [])),
    );
    vi.spyOn(models, 'embed').mockImplementation(async (inputs) => {
      if (embedGate) await embedGate.promise;
      return inputs.map(() => [0.5, 0.5, 0.5, 0.5]);
    });
    vi.spyOn(models, 'embedQuery').mockResolvedValue([0.5, 0.5, 0.5, 0.5]);
    vi.spyOn(models, 'rerank').mockResolvedValue(null);
  });

  afterEach(() => {
    embedGate?.resolve();
    extractGate?.resolve();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (qdrant && (await qdrant.collectionExists(COLLECTION)).exists) {
      await qdrant.deleteCollection(COLLECTION);
    }
    await e2e?.close();
  });

  describe('authorization', () => {
    it('requires a token', async () => {
      const response = await http().get(route).expect(401);

      expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it.each([
      ['get', ''],
      ['post', ''],
      ['get', `/${randomUUID()}`],
      ['get', `/${randomUUID()}/pages`],
      ['patch', `/${randomUUID()}/pages/1`],
      ['get', `/${randomUUID()}/file-url`],
      ['post', `/${randomUUID()}/approve`],
      ['post', `/${randomUUID()}/reject`],
      ['post', `/${randomUUID()}/reopen`],
      ['delete', `/${randomUUID()}`],
    ] as const)(
      'refuses a member on %s %s with 403 FORBIDDEN',
      async (method, path) => {
        const response = await http()
          [method](`${route}${path}`)
          .auth(memberToken, { type: 'bearer' })
          .send({});

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
      },
    );
  });

  describe('upload validation', () => {
    const upload = (body: object) =>
      http().post(route).auth(adminToken, { type: 'bearer' }).send(body);

    it('creates a WAITING_UPLOAD document with a presigned PUT', async () => {
      const response = await upload({
        filename: 'Bang Thanh Phan.PDF',
        sizeBytes: 1234,
      }).expect(201);

      expect(response.body).toMatchObject({
        document: {
          title: 'Bang Thanh Phan.PDF',
          status: KnowledgeDocumentStatus.WAITING_UPLOAD,
          failureReason: null,
          reviewedById: null,
        },
        upload: { method: 'PUT' },
      });
    });

    it('accepts a file of exactly MAX_KNOWLEDGE_FILE_MB', async () => {
      await upload({ filename: 'a.pdf', sizeBytes: 50 * MB }).expect(201);
    });

    it('refuses a file one byte over the limit with 413 FILE_TOO_LARGE', async () => {
      const response = await upload({
        filename: 'a.pdf',
        sizeBytes: 50 * MB + 1,
      }).expect(413);

      expect(response.body).toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it.each(['anh.jpg', 'report.pdf.exe', 'pdf', 'notes.pdfx'])(
      'refuses %s with 415 UNSUPPORTED_FILE_TYPE',
      async (filename) => {
        const response = await upload({ filename, sizeBytes: 10 }).expect(415);

        expect(response.body).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
      },
    );

    it.each([
      ['a zero size', { filename: 'a.pdf', sizeBytes: 0 }],
      ['a fractional size', { filename: 'a.pdf', sizeBytes: 1.5 }],
      ['a size given as a string', { filename: 'a.pdf', sizeBytes: '10' }],
      ['an empty filename', { filename: '', sizeBytes: 10 }],
      [
        'a 256-character filename',
        { filename: `${'a'.repeat(252)}.pdf`, sizeBytes: 10 },
      ],
      [
        'an undeclared field',
        { filename: 'a.pdf', sizeBytes: 10, status: 'READY' },
      ],
    ])('refuses %s with 400 VALIDATION_FAILED', async (_case, body) => {
      const response = await upload(body).expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('stores nothing when validation fails', async () => {
      const before = await documents().countDocuments();

      await upload({ filename: 'a.jpg', sizeBytes: 10 }).expect(415);

      expect(await documents().countDocuments()).toBe(before);
    });
  });

  describe('path validation', () => {
    it('refuses a non-UUID document id with 400', async () => {
      await http()
        .get(`${route}/not-a-uuid`)
        .auth(adminToken, { type: 'bearer' })
        .expect(400);
    });

    it('refuses a non-integer page number with 400', async () => {
      await http()
        .patch(`${route}/${randomUUID()}/pages/1.5`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'x' })
        .expect(400);
    });

    it('answers 404 NOT_FOUND for an unknown document', async () => {
      const response = await http()
        .get(`${route}/${randomUUID()}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(404);

      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('ingestion', () => {
    it('parks the OCR text for review with one page per PDF page', async () => {
      const { id } = await uploadAndExtract(['Trang 1', 'Trang 2', 'Trang 3']);

      const response = await http()
        .get(`${route}/${id}/pages`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      expect(response.body).toEqual([
        { page: 1, text: 'Trang 1', flags: [], edited: false },
        { page: 2, text: 'Trang 2', flags: [], edited: false },
        { page: 3, text: 'Trang 3', flags: [], edited: false },
      ]);
      expect(await documents().findById(id).exec()).toMatchObject({
        sectionCount: 3,
        sizeBytes: 3,
        failureReason: null,
      });
    });

    it('indexes nothing before an admin approves', async () => {
      const { id } = await uploadAndExtract();

      expect(await pointCount(id)).toBe(0);
    });

    // BUG-4: a stuck extraction that the cron already FAILED is revived by the late OCR result
    it('keeps a document FAILED when its interrupted extraction finishes after the cron failed it', async () => {
      extractGate = deferred<void>();
      const runs = watchBackgroundRuns('ingest');
      const { id, storageKey } = await startUpload();
      await knowledge.markUploaded(storageKey);
      await backdate(id);
      await maintenance.failIncomplete();
      expect(await statusOf(id)).toBe(KnowledgeDocumentStatus.FAILED);

      extractGate.resolve();
      await allSettled(runs);

      expect(await documents().findById(id).exec()).toMatchObject({
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
      });
    });
  });

  describe('page review', () => {
    it('saves a corrected page and marks it edited', async () => {
      const { id } = await uploadAndExtract();

      const response = await http()
        .patch(`${route}/${id}/pages/2`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'Rau cải xoăn: 150 mg canxi.' })
        .expect(200);

      expect(response.body).toEqual({
        page: 2,
        text: 'Rau cải xoăn: 150 mg canxi.',
        flags: [],
        edited: true,
      });
    });

    it('accepts an empty page text', async () => {
      const { id } = await uploadAndExtract();

      await http()
        .patch(`${route}/${id}/pages/1`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: '' })
        .expect(200);
    });

    it('refuses a text over 100,000 characters with 400', async () => {
      const { id } = await uploadAndExtract();

      await http()
        .patch(`${route}/${id}/pages/1`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'a'.repeat(100_001) })
        .expect(400);
    });

    it.each([0, 3, -1])(
      'answers 404 for page %i that does not exist',
      async (page) => {
        const { id } = await uploadAndExtract();

        await http()
          .patch(`${route}/${id}/pages/${page}`)
          .auth(adminToken, { type: 'bearer' })
          .send({ text: 'x' })
          .expect(404);
      },
    );

    it('presigns the original PDF for 15 minutes', async () => {
      const { id, storageKey } = await uploadAndExtract();
      const before = Date.now();

      const response = await http()
        .get(`${route}/${id}/file-url`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      const body = response.body as { url: string; expiresAt: string };
      expect(body.url).toContain(storageKey);
      const ttl = Date.parse(body.expiresAt) - before;
      expect(ttl).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
      expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5000);
    });
  });

  describe('approve and index', () => {
    it('answers INDEXING with the review note, then becomes READY', async () => {
      const { id } = await uploadAndExtract();

      const response = await approve(id, { note: 'Nguồn tin cậy' }).expect(200);

      expect(response.body).toMatchObject({
        id,
        status: KnowledgeDocumentStatus.INDEXING,
        reviewedById: admin.id,
        reviewNote: 'Nguồn tin cậy',
      });
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
    });

    it('indexes the reviewed text into Qdrant once READY', async () => {
      const { id } = await uploadAndExtract();

      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      expect(await pointCount(id)).toBeGreaterThan(0);
    });

    it('indexes the admin-corrected page text, not the raw OCR', async () => {
      const { id } = await uploadAndExtract(['Dau phu']);
      await http()
        .patch(`${route}/${id}/pages/1`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'Đậu phụ giàu canxi' })
        .expect(200);

      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      const [texts] = vi.mocked(models.embed).mock.calls[0] as [string[]];
      expect(texts).toEqual([
        'title: dinh-duong.pdf | text: Đậu phụ giàu canxi',
      ]);
    });

    it('lets exactly one of two simultaneous approvals through', async () => {
      const { id } = await uploadAndExtract();

      const [first, second] = await Promise.all([approve(id), approve(id)]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const conflict = first.status === 409 ? first : second;
      expect(conflict.body).toMatchObject({
        statusCode: 409,
        code: 'DOCUMENT_NOT_REVIEWABLE',
      });
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
    });

    it('refuses to approve a READY document with 409 DOCUMENT_NOT_REVIEWABLE', async () => {
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      const response = await approve(id).expect(409);

      expect(response.body).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
    });

    it('refuses to approve a document still waiting for its upload', async () => {
      const { id } = await startUpload();

      const response = await approve(id).expect(409);

      expect(response.body).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
    });

    it('refuses a review note over 500 characters', async () => {
      const { id } = await uploadAndExtract();

      await approve(id, { note: 'n'.repeat(501) }).expect(400);
      expect(await statusOf(id)).toBe(KnowledgeDocumentStatus.AWAITING_REVIEW);
    });

    it('refuses page edits while indexing', async () => {
      embedGate = deferred<void>();
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);

      const response = await http()
        .patch(`${route}/${id}/pages/1`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'x' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
      embedGate.resolve();
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
    });

    it('returns to review with INDEXING_FAILED when embedding fails', async () => {
      const { id } = await uploadAndExtract();
      vi.mocked(models.embed).mockRejectedValueOnce(
        new Error('OpenRouter 502'),
      );

      await approve(id).expect(200);
      await vi.waitFor(async () =>
        expect((await documents().findById(id).exec())?.failureReason).toBe(
          KnowledgeDocumentFailureReason.INDEXING_FAILED,
        ),
      );

      expect(await documents().findById(id).exec()).toMatchObject({
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        reviewedById: null,
        reviewNote: null,
      });
    });

    it('can be approved again after a failed run and indexes every page once', async () => {
      const { id } = await uploadAndExtract();
      vi.mocked(models.embed).mockRejectedValueOnce(
        new Error('OpenRouter 502'),
      );
      const runs = watchBackgroundRuns('indexApproved');
      await approve(id).expect(200);
      await allSettled(runs);
      expect(await statusOf(id)).toBe(KnowledgeDocumentStatus.AWAITING_REVIEW);

      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      // Two short pages, no images: one chunk each.
      expect(await pointCount(id)).toBe(CALCIUM_PAGES.length);
    });

    // BUG-5: overlapping index runs (stuck run returned to review, then re-approved) duplicate points
    it('keeps one copy of the points when a stuck run and its re-approval both finish', async () => {
      const { id } = await uploadAndExtract();
      // Two short pages, no images: one run indexes two chunks.
      const singleRun = CALCIUM_PAGES.length;
      const runs = watchBackgroundRuns('indexApproved');
      const firstRun = deferred<void>();
      embedGate = firstRun;
      await approve(id).expect(200);
      await vi.waitFor(() => expect(models.embed).toHaveBeenCalledTimes(2));
      await backdate(id);
      await maintenance.failIncomplete();
      const secondRun = deferred<void>();
      embedGate = secondRun;
      await approve(id).expect(200);
      await vi.waitFor(() => expect(models.embed).toHaveBeenCalledTimes(4));
      // Interleave deterministically: both runs clear the old points before
      // either writes its new ones (each run is remove-then-upsert).
      const realDelete = qdrant.delete.bind(qdrant);
      const realUpsert = qdrant.upsert.bind(qdrant);
      const bothRemoved = deferred<void>();
      let removals = 0;
      vi.spyOn(qdrant, 'delete').mockImplementation(async (...args) => {
        const result = await realDelete(...args);
        removals += 1;
        if (removals === 2) bothRemoved.resolve();
        return result;
      });
      vi.spyOn(qdrant, 'upsert').mockImplementation(async (...args) => {
        await bothRemoved.promise;
        return realUpsert(...args);
      });

      firstRun.resolve();
      secondRun.resolve();
      await allSettled(runs);

      expect(await statusOf(id)).toBe(KnowledgeDocumentStatus.READY);

      expect(await pointCount(id)).toBe(singleRun);
    });

    // BUG-3: a run the cron gave up on still marks a since-REJECTED document READY and searchable
    it('keeps a document REJECTED when an interrupted indexing run finishes after the rejection', async () => {
      embedGate = deferred<void>();
      const runs = watchBackgroundRuns('indexApproved');
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await vi.waitFor(() => expect(models.embed).toHaveBeenCalled());
      await backdate(id);
      await maintenance.failIncomplete();
      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({ note: 'Sai nguồn' })
        .expect(200);

      embedGate.resolve();
      await allSettled(runs);

      expect(await statusOf(id)).toBe(KnowledgeDocumentStatus.REJECTED);
      expect(await pointCount(id)).toBe(0);
    });
  });

  describe('reject and reopen', () => {
    it('rejects with the note and keeps the pages', async () => {
      const { id } = await uploadAndExtract();

      const response = await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({ note: 'Sai nguồn' })
        .expect(200);

      expect(response.body).toMatchObject({
        status: KnowledgeDocumentStatus.REJECTED,
        reviewedById: admin.id,
        reviewNote: 'Sai nguồn',
      });
      expect(await pages().countDocuments({ documentId: id })).toBe(2);
      expect(await pointCount(id)).toBe(0);
    });

    it('refuses page edits on a rejected document with 409', async () => {
      const { id } = await uploadAndExtract();
      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({})
        .expect(200);

      const response = await http()
        .patch(`${route}/${id}/pages/1`)
        .auth(adminToken, { type: 'bearer' })
        .send({ text: 'x' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
    });

    it('refuses to approve a rejected document until it is reopened', async () => {
      const { id } = await uploadAndExtract();
      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({})
        .expect(200);

      await approve(id).expect(409);
      await http()
        .post(`${route}/${id}/reopen`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
    });

    it('clears the earlier decision when reopening', async () => {
      const { id } = await uploadAndExtract();
      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({ note: 'x' })
        .expect(200);

      const response = await http()
        .post(`${route}/${id}/reopen`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      expect(response.body).toMatchObject({
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        failureReason: null,
      });
    });

    it('refuses to reopen a document that is not rejected', async () => {
      const { id } = await uploadAndExtract();

      const response = await http()
        .post(`${route}/${id}/reopen`)
        .auth(adminToken, { type: 'bearer' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
    });

    it('refuses to reject twice', async () => {
      const { id } = await uploadAndExtract();
      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({})
        .expect(200);

      await http()
        .post(`${route}/${id}/reject`)
        .auth(adminToken, { type: 'bearer' })
        .send({})
        .expect(409);
    });
  });

  describe('delete', () => {
    const remove = (id: string) =>
      http().delete(`${route}/${id}`).auth(adminToken, { type: 'bearer' });

    it('removes a READY document, its pages and its Qdrant points', async () => {
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      await remove(id).expect(204);

      await http()
        .get(`${route}/${id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
      expect(await pages().countDocuments({ documentId: id })).toBe(0);
      expect(await pointCount(id)).toBe(0);
    });

    it('answers 404 to a second delete', async () => {
      const { id } = await uploadAndExtract();
      await remove(id).expect(204);

      await remove(id).expect(404);
    });

    it('keeps other documents searchable', async () => {
      const kept = await uploadAndExtract();
      await approve(kept.id).expect(200);
      await waitForStatus(kept.id, KnowledgeDocumentStatus.READY);
      const removed = await uploadAndExtract();
      await approve(removed.id).expect(200);
      await waitForStatus(removed.id, KnowledgeDocumentStatus.READY);
      const keptPoints = await pointCount(kept.id);

      await remove(removed.id).expect(204);

      expect(await pointCount(kept.id)).toBe(keptPoints);
    });

    // BUG-1: DELETE during INDEXING leaves the document's points in Qdrant
    it('leaves no Qdrant points when deleted while indexing', async () => {
      embedGate = deferred<void>();
      const runs = watchBackgroundRuns('indexApproved');
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await vi.waitFor(() => expect(models.embed).toHaveBeenCalled());

      await remove(id).expect(204);
      embedGate.resolve();
      await allSettled(runs);

      expect(await documents().findById(id).exec()).toBeNull();
      expect(await pointCount(id)).toBe(0);
    });

    // BUG-2: DELETE during PROCESSING leaves orphan OCR pages
    it('leaves no pages when deleted while the OCR is running', async () => {
      extractGate = deferred<void>();
      const runs = watchBackgroundRuns('ingest');
      const { id, storageKey } = await startUpload();
      await knowledge.markUploaded(storageKey);
      await vi.waitFor(() => expect(pdf.extract).toHaveBeenCalled());

      await remove(id).expect(204);
      extractGate.resolve();
      await allSettled(runs);

      expect(await documents().findById(id).exec()).toBeNull();
      expect(await pages().countDocuments({ documentId: id })).toBe(0);
    });
  });

  describe('retrieval', () => {
    const search = (query: string) =>
      e2e.app.get(KnowledgeSearchService).search(query);

    it('finds an approved passage with its title and page', async () => {
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);

      const hits = await search('canxi đậu phụ');

      expect(hits).toContainEqual(
        expect.objectContaining({ title: 'dinh-duong.pdf', page: 1 }),
      );
    });

    it('falls back to the fused order when the reranker fails', async () => {
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
      vi.mocked(models.rerank).mockRejectedValue(new Error('rerank 503'));

      const hits = await search('canxi');

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(6);
    });

    it('returns only the passages the reranker keeps above the bar, best first', async () => {
      const { id } = await uploadAndExtract();
      await approve(id).expect(200);
      await waitForStatus(id, KnowledgeDocumentStatus.READY);
      vi.mocked(models.rerank).mockImplementation((_query, documents) =>
        Promise.resolve(
          documents.map((_text, index) => ({
            index,
            relevanceScore: index === 0 ? 0.9 : 0.01,
          })),
        ),
      );

      const hits = await search('canxi');

      expect(hits).toHaveLength(1);
    });
  });
});
