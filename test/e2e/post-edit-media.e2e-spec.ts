import request from 'supertest';
import {
  MediaAsset,
  MediaStatus,
  Post,
  PostStatus,
  type User,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createMedia, createPost, createUser } from '@test/support/fixtures.js';

interface PostBody {
  id: string;
  status: PostStatus;
  body: string | null;
}

describe('Editing the videos of a post (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let authorToken: string;
  const server = () => e2e.app.getHttpServer();
  const posts = () => e2e.mongo.connection.model<Post>(Post.name);
  const media = () => e2e.mongo.connection.model<MediaAsset>(MediaAsset.name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_edit_media_e2e');
    author = await createUser(e2e.mongo, { username: 'vedora.chef' });
    stranger = await createUser(e2e.mongo, { username: 'vedora.other' });
    authorToken = await e2e.sign(author);
  });
  beforeEach(async () => {
    await posts().deleteMany({});
    await media().deleteMany({});
  });
  afterAll(async () => {
    await e2e.close();
  });

  const patch = (id: string, payload: object) =>
    request(server())
      .patch(`/api/v1/posts/${id}`)
      .auth(authorToken, { type: 'bearer' })
      .send(payload);

  const postWithVideos = async (
    body: string | null,
    statuses: MediaStatus[],
    postStatus = PostStatus.PUBLISHED,
  ) => {
    const post = await createPost(e2e.mongo, {
      authorId: author.id,
      status: postStatus,
      body,
    });
    const videos: MediaAsset[] = [];
    for (const [position, status] of statuses.entries()) {
      videos.push(
        await createMedia(e2e.mongo, {
          ownerId: author.id,
          postId: post.id,
          position,
          status,
        }),
      );
    }
    return { post, videos };
  };
  const attachedIds = async (postId: string) => {
    const rows = await media()
      .find({ postId, discardedAt: null })
      .sort({ position: 1 })
      .exec();
    return rows.map(({ id }) => id);
  };

  const expectDiscarded = async (mediaId: string) => {
    const row = await media().findById(mediaId).exec();
    // The Cloudinary copy is purged by the maintenance job, so the row may
    // still exist, but it no longer belongs to any post.
    expect(
      row === null || (row.postId === null && row.discardedAt !== null),
    ).toBe(true);
  };

  it('needs a body or mediaIds', async () => {
    const { post } = await postWithVideos('Chào', []);
    await patch(post.id, {}).expect(400);
  });

  it('removes the video and publishes a post that keeps its text', async () => {
    const { post, videos } = await postWithVideos('Chào', [MediaStatus.READY]);
    const response = await patch(post.id, { mediaIds: [] }).expect(200);
    expect((response.body as PostBody).status).toBe(PostStatus.PUBLISHED);
    expect(await attachedIds(post.id)).toEqual([]);
    await expectDiscarded(videos[0].id);
  });

  it('keeps the post hidden while a new video is still uploading', async () => {
    const { post, videos } = await postWithVideos('Chào', [MediaStatus.READY]);
    const fresh = await createMedia(e2e.mongo, {
      ownerId: author.id,
      status: MediaStatus.PROCESSING,
    });
    const response = await patch(post.id, {
      mediaIds: [videos[0].id, fresh.id],
    }).expect(200);
    expect((response.body as PostBody).status).toBe(PostStatus.PROCESSING);
    expect(await attachedIds(post.id)).toEqual([videos[0].id, fresh.id]);
    await request(server()).get(`/api/v1/posts/${post.id}`).expect(404);
  });

  it('reorders the videos', async () => {
    const { post, videos } = await postWithVideos('Chào', [
      MediaStatus.READY,
      MediaStatus.READY,
    ]);
    await patch(post.id, { mediaIds: [videos[1].id, videos[0].id] }).expect(
      200,
    );
    expect(await attachedIds(post.id)).toEqual([videos[1].id, videos[0].id]);
  });

  it('leaves the post alone when nothing changed', async () => {
    const { post, videos } = await postWithVideos('Chào', [MediaStatus.READY]);
    const response = await patch(post.id, {
      body: 'Chào',
      mediaIds: [videos[0].id],
    }).expect(200);
    expect((response.body as PostBody).status).toBe(PostStatus.PUBLISHED);
  });

  it("refuses media that is someone else's or already used", async () => {
    const { post } = await postWithVideos('Chào', []);
    const foreign = await createMedia(e2e.mongo, {
      ownerId: stranger.id,
      status: MediaStatus.READY,
    });
    await patch(post.id, { mediaIds: [foreign.id] }).expect(400);

    const other = await postWithVideos('Bài khác', [MediaStatus.READY]);
    await patch(post.id, { mediaIds: [other.videos[0].id] }).expect(400);

    expect(await attachedIds(post.id)).toEqual([]);
    expect(
      (await posts().findById(post.id).exec())?.status,
      'a refused edit leaves the post as it was',
    ).toBe(PostStatus.PUBLISHED);
  });

  it('refuses to leave a post with neither text nor video', async () => {
    const { post, videos } = await postWithVideos(null, [MediaStatus.READY]);
    await patch(post.id, { mediaIds: [] }).expect(400);
    expect(await attachedIds(post.id)).toEqual([videos[0].id]);
    await patch(post.id, { mediaIds: [], body: 'Chỉ còn chữ' }).expect(200);
    expect(await attachedIds(post.id)).toEqual([]);
  });

  it('lets a failed post be fixed by replacing its video', async () => {
    const { post, videos } = await postWithVideos(
      'Chào',
      [MediaStatus.FAILED],
      PostStatus.FAILED,
    );
    const fresh = await createMedia(e2e.mongo, {
      ownerId: author.id,
      status: MediaStatus.PROCESSING,
    });
    const response = await patch(post.id, { mediaIds: [fresh.id] }).expect(200);
    expect((response.body as PostBody).status).toBe(PostStatus.PROCESSING);
    expect(await attachedIds(post.id)).toEqual([fresh.id]);
    await expectDiscarded(videos[0].id);
  });

  it('refuses to keep a video that failed, and leaves the post as it was', async () => {
    const { post, videos } = await postWithVideos(
      'Chào',
      [MediaStatus.FAILED],
      PostStatus.FAILED,
    );
    await patch(post.id, {
      body: 'Chào lại',
      mediaIds: [videos[0].id],
    }).expect(400);
    const row = await posts().findById(post.id).exec();
    expect(row?.status).toBe(PostStatus.FAILED);
    expect(row?.body).toBe('Chào');
  });

  it('ignores a removed video when the post settles', async () => {
    const { post, videos } = await postWithVideos('Chào', [
      MediaStatus.READY,
      MediaStatus.FAILED,
    ]);
    const response = await patch(post.id, {
      mediaIds: [videos[0].id],
    }).expect(200);
    expect((response.body as PostBody).status).not.toBe(PostStatus.FAILED);
  });
});
