import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import type {
  PostDraftDto,
  PostDraftPageDto,
  DraftUploadResponseDto,
} from '@src/posts/dto/post-draft.dto.js';
import type { PostResponseDto } from '@src/posts/dto/post-response.dto.js';
const typed = <T>(response: Response) => ({
  ...response,
  body: response.body as T,
});
import { CloudinaryService } from '@src/cloudinary/cloudinary.service.js';
import { MediaService } from '@src/media/media.service.js';
import { PostSearchIndexService } from '@src/posts/search/post-search-index.service.js';
import {
  MediaAsset,
  MediaStatus,
  Post,
  PostStatus,
  PostType,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';
import { runtimeConfig } from '@src/config/runtime-config.js';

vi.mock('@src/common/http/fetch-public-image.js', () => ({
  fetchPublicImage: vi.fn().mockResolvedValue(Buffer.from('fixture-image')),
}));

describe('Private post/video drafts (e2e)', () => {
  let e2e: E2eApp;
  let token: string;
  let otherToken: string;
  let ownerId: string;
  const cloudinary = {
    configured: true,
    webhooksEnabled: true,
    require: vi.fn(),
    videoPublicId: (id: string) => `fixture/videos/${id}`,
    mediaIdOf: (publicId: string) => publicId.split('/').at(-1),
    signVideoUpload: (publicId: string) => ({
      url: 'https://fixture.invalid/upload',
      fields: { public_id: publicId },
      chunkSize: 1048576,
    }),
    findVideo: vi.fn().mockResolvedValue(null),
    hlsUrl: (id: string) => `https://fixture.invalid/${id}.m3u8`,
    posterUrl: (id: string) => `https://fixture.invalid/${id}.jpg`,
    originalUrl: (id: string) => `https://fixture.invalid/${id}.mp4`,
    frameUrl: () => 'https://fixture.invalid/frame.jpg',
  };
  const server = () => e2e.app.getHttpServer();
  const posts = () => e2e.connection.model<Post>(Post.name);
  const media = () => e2e.connection.model<MediaAsset>(MediaAsset.name);
  const path = (id?: string, suffix = '') =>
    `/api/v1/posts/drafts${id ? `/${id}` : ''}${suffix}`;
  const create = (id = randomUUID(), kind = 'POST') =>
    request(server())
      .post(path())
      .auth(token, { type: 'bearer' })
      .send({ id, kind })
      .expect(201)
      .then(typed<PostDraftDto>);

  beforeAll(async () => {
    e2e = await createE2eApp('post_drafts_e2e', (builder) =>
      builder
        .overrideProvider(CloudinaryService)
        .useValue(cloudinary)
        .overrideProvider(PostSearchIndexService)
        .useValue({ schedule: vi.fn(), remove: vi.fn() }),
    );
    const owner = await createUser(e2e.mongo);
    const other = await createUser(e2e.mongo);
    ownerId = owner.id;
    token = await e2e.sign(owner);
    otherToken = await e2e.sign(other);
  });
  afterAll(async () => {
    await e2e?.close();
  });
  beforeEach(async () => {
    await posts().deleteMany({});
    await media().deleteMany({});
  });

  it('requires auth, separates owners, omits blog drafts and keeps drafts out of public reads', async () => {
    await request(server()).get(path()).expect(401);
    const { body: draft } = await create();
    await createPost(e2e.mongo, {
      authorId: ownerId,
      type: PostType.BLOG,
      status: PostStatus.DRAFT,
    });
    const list = await request(server())
      .get(path())
      .auth(token, { type: 'bearer' })
      .expect(200)
      .then(typed<PostDraftPageDto>);
    expect(list.headers['cache-control']).toBe('private, no-store');
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([
      draft.id,
    ]);
    for (const method of ['get', 'patch', 'delete'] as const) {
      await request(server())
        [method](path(draft.id))
        .auth(otherToken, { type: 'bearer' })
        .send({ expectedVersion: 0, body: 'stolen' })
        .expect(404);
    }
    await request(server())
      .get(`/api/v1/posts/${draft.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(404);
    const feed = await request(server())
      .get('/api/v1/posts/feed')
      .auth(otherToken, { type: 'bearer' })
      .expect(200)
      .then(typed<{ items: PostResponseDto[] }>);
    expect(feed.body.items).toHaveLength(0);
  });

  it('creates and signs idempotently, guards attachment ownership and video-guide limits', async () => {
    const id = randomUUID(),
      mediaId = randomUUID();
    await Promise.all([create(id, 'VIDEO'), create(id, 'VIDEO')]);
    expect(await posts().countDocuments({ _id: id })).toBe(1);
    const upload = () =>
      request(server())
        .post(path(id, '/uploads'))
        .auth(token, { type: 'bearer' })
        .send({ mediaId });
    const first = await upload()
      .expect(201)
      .then(typed<DraftUploadResponseDto>);
    const retry = await upload()
      .expect(201)
      .then(typed<DraftUploadResponseDto>);
    expect(retry.body.draft.version).toBe(first.body.draft.version);
    expect(retry.body.media.id).toBe(mediaId);
    expect(await media().countDocuments({ postId: id })).toBe(1);
    await request(server())
      .post(path(id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId: randomUUID() })
      .expect(400);
    const { body: another } = await create();
    await request(server())
      .post(path(another.id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId })
      .expect(400);
  });

  it('prevents stale writes and tolerates lost save responses without incrementing twice', async () => {
    const { body: draft } = await create();
    const save = (body: string) =>
      request(server())
        .patch(path(draft.id))
        .auth(token, { type: 'bearer' })
        .send({ expectedVersion: 0, body });
    const saved = await save('Vegan dinner')
      .expect(200)
      .then(typed<PostDraftDto>);
    expect(saved.body.version).toBe(1);
    expect(new Date(saved.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(draft.updatedAt).getTime(),
    );
    await save('Stale different text').expect(409);
    const retry = await save('Vegan dinner')
      .expect(200)
      .then(typed<PostDraftDto>);
    expect(retry.body.version).toBe(1);
    expect((await posts().findById(draft.id))?.body).toBe('Vegan dinner');
  });

  it('never auto-publishes a draft on upload settlement, including failed media', async () => {
    const { body: draft } = await create(randomUUID(), 'VIDEO');
    const { body: target } = await request(server())
      .post(path(draft.id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId: randomUUID() })
      .expect(201)
      .then(typed<DraftUploadResponseDto>);
    for (const status of [MediaStatus.READY, MediaStatus.FAILED]) {
      await media().updateOne({ _id: target.media.id }, { $set: { status } });
      await e2e.app.get(MediaService).settlePosts([draft.id]);
      expect((await posts().findById(draft.id))?.status).toBe(PostStatus.DRAFT);
    }
  });

  it('blocks publish until upload finishes, then publishes explicitly and retries without duplicates', async () => {
    const { body: draft } = await create(randomUUID(), 'VIDEO');
    const { body: saved } = await request(server())
      .patch(path(draft.id))
      .auth(token, { type: 'bearer' })
      .send({
        expectedVersion: 0,
        title: 'Vegan soup',
        description: 'Cook the vegetables.',
      })
      .expect(200)
      .then(typed<PostDraftDto>);
    const { body: target } = await request(server())
      .post(path(draft.id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId: randomUUID() })
      .expect(201)
      .then(typed<DraftUploadResponseDto>);
    const publish = () =>
      request(server())
        .post(path(draft.id, '/publish'))
        .auth(token, { type: 'bearer' })
        .send({ expectedVersion: target.draft.version });
    expect(saved.version).toBe(1);
    await publish().expect(400);
    await media().updateOne(
      { _id: target.media.id },
      {
        $set: {
          status: MediaStatus.READY,
          durationSec: 10,
          width: 640,
          height: 480,
        },
      },
    );
    const responses = await Promise.all([
      publish()
        .expect(200)
        .then(typed<PostResponseDto>),
      publish()
        .expect(200)
        .then(typed<PostResponseDto>),
    ]);
    expect(responses.every((response) => response.body.id === draft.id)).toBe(
      true,
    );
    expect((await posts().findById(draft.id))?.status).toBe(
      PostStatus.PUBLISHED,
    );
    expect(await posts().countDocuments({ authorId: ownerId })).toBe(1);
    const list = await request(server())
      .get(path())
      .auth(token, { type: 'bearer' })
      .expect(200)
      .then(typed<PostDraftPageDto>);
    expect(list.body.items).toHaveLength(0);
  });

  it('reconciles a finished upload on retry instead of issuing another signature', async () => {
    const { body: draft } = await create();
    const mediaId = randomUUID();
    const target = () =>
      request(server())
        .post(path(draft.id, '/uploads'))
        .auth(token, { type: 'bearer' })
        .send({ mediaId })
        .expect(201);
    await target();
    await media().updateOne(
      { _id: mediaId },
      { $set: { status: MediaStatus.READY } },
    );
    expect(
      typed<DraftUploadResponseDto>(await target()).body.upload,
    ).toBeNull();
    expect(await media().countDocuments({ postId: draft.id })).toBe(1);
  });

  it('discards removed attachments, enforces versions and deletes only the private draft', async () => {
    const { body: draft } = await create();
    const mediaId = randomUUID();
    const { body: target } = await request(server())
      .post(path(draft.id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId })
      .expect(201)
      .then(typed<DraftUploadResponseDto>);
    const remove = (expectedVersion: number) =>
      request(server())
        .delete(path(draft.id, `/media/${mediaId}`))
        .auth(token, { type: 'bearer' })
        .send({ expectedVersion });
    await remove(0).expect(409);
    await remove(target.draft.version).expect(200);
    await remove(target.draft.version).expect(200);
    expect((await media().findById(mediaId))?.discardedAt).toBeInstanceOf(Date);
    await request(server())
      .delete(path(draft.id))
      .auth(token, { type: 'bearer' })
      .expect(204);
    expect(await posts().findById(draft.id)).toBeNull();
    await request(server())
      .get(path(draft.id))
      .auth(token, { type: 'bearer' })
      .expect(404);
  });

  it('limits private drafts per owner and allows a new one after deletion', async () => {
    const drafts = await Promise.all(
      Array.from({ length: runtimeConfig.POST_MAX_DRAFTS_PER_USER }, () =>
        createPost(e2e.mongo, {
          authorId: ownerId,
          type: PostType.POST,
          status: PostStatus.DRAFT,
          draftKind: 'POST',
        }),
      ),
    );
    await request(server())
      .post(path())
      .auth(token, { type: 'bearer' })
      .send({ id: randomUUID(), kind: 'POST' })
      .expect(429);
    await request(server())
      .delete(path(drafts[0].id))
      .auth(token, { type: 'bearer' })
      .expect(204);
    await create();
    expect(
      await posts().countDocuments({
        authorId: ownerId,
        status: PostStatus.DRAFT,
      }),
    ).toBe(runtimeConfig.POST_MAX_DRAFTS_PER_USER);
  });

  it('refreshes pending video state on read when webhooks are disabled', async () => {
    const { body: draft } = await create();
    const mediaId = randomUUID();
    await request(server())
      .post(path(draft.id, '/uploads'))
      .auth(token, { type: 'bearer' })
      .send({ mediaId })
      .expect(201);
    const refresh = vi
      .spyOn(e2e.app.get(MediaService), 'refresh')
      .mockImplementation(async (item) => {
        await media().updateOne(
          { _id: item.id },
          { $set: { status: MediaStatus.PROCESSING } },
        );
      });
    cloudinary.webhooksEnabled = false;
    try {
      const response = await request(server())
        .get(path(draft.id))
        .auth(token, { type: 'bearer' })
        .expect(200)
        .then(typed<PostDraftDto>);
      expect(refresh).toHaveBeenCalledOnce();
      expect(response.body.media[0].status).toBe(MediaStatus.PROCESSING);
      expect((await posts().findById(draft.id))?.status).toBe(PostStatus.DRAFT);
    } finally {
      refresh.mockRestore();
      cloudinary.webhooksEnabled = true;
    }
  });
});
