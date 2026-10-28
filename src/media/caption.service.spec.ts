import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { createMedia, createPost, createUser } from '../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  CaptionStatus,
  type MediaAsset,
  MediaStatus,
  type Post,
  PostStatus,
} from '../mongo/models.js';
import { CaptionService } from './caption.service.js';
import * as speechAudio from './captions/speech-audio.js';
import { TranscriptionService } from './captions/transcription.service.js';

vi.mock('./captions/speech-audio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof speechAudio>()),
  extractSpeechAudio: vi.fn(),
}));

describe('CaptionService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: CaptionService;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let transcription: DeepMockProxy<TranscriptionService>;
  let media: MediaAsset;
  const extract = vi.mocked(speechAudio.extractSpeechAudio);
  const cues = [{ start: 5, end: 8, text: 'Xin chào' }];

  const assets = () => db.connection.model<MediaAsset>('MediaAsset');
  const posts = () => db.connection.model<Post>('Post');
  const reload = (id: string) => assets().findById(id).exec();
  const addMedia = (fields: Partial<MediaAsset> = {}) =>
    createMedia(db, { status: MediaStatus.READY, durationSec: 42, ...fields });

  beforeAll(async () => {
    cloudinary = mockDeep<CloudinaryService>();
    transcription = mockDeep<TranscriptionService>();
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('captions'))],
      providers: [
        CaptionService,
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: TranscriptionService, useValue: transcription },
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(CaptionService);
  });
  beforeEach(async () => {
    await assets().deleteMany({});
    await posts().deleteMany({});
    media = await addMedia();

    cloudinary.originalUrl.mockReturnValue('https://cdn/original');
    cloudinary.uploadCaption.mockImplementation((_id, language) =>
      Promise.resolve(`https://cdn/${language}.vtt`),
    );
    extract.mockReset();
    extract.mockResolvedValue({
      audio: Buffer.from('mp3'),
      speech: [{ start: 5, end: 8 }],
    });
    transcription.transcribe.mockReset();
    transcription.transcribe.mockResolvedValue({ language: 'vi', cues });
    transcription.translate.mockReset();
    transcription.translate.mockResolvedValue([{ ...cues[0], text: 'Hello' }]);
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('stores the spoken captions and their English translation', async () => {
    await service.caption(media);

    expect(extract).toHaveBeenCalledWith('https://cdn/original', 42);
    expect(transcription.translate).toHaveBeenCalledWith(cues, 'vi', 'en');
    expect(await reload(media.id)).toMatchObject({
      captionStatus: CaptionStatus.READY,
      captionLanguage: 'vi',
      transcript: 'Xin chào',
      captions: [
        {
          languageCode: 'vi',
          name: 'Tiếng Việt',
          isOriginal: true,
          url: 'https://cdn/vi.vtt',
        },
        {
          languageCode: 'en',
          name: 'English',
          isOriginal: false,
          url: 'https://cdn/en.vtt',
        },
      ],
    });
  });

  it('marks the post for embedding again once its video is captioned', async () => {
    const author = await createUser(db);
    const post = await createPost(db, {
      authorId: author.id,
      searchIndexedAt: new Date(),
    });
    media = await addMedia({ postId: post.id });

    await service.caption(media);

    const stored = await posts().findById(post.id).exec();
    expect(stored?.searchIndexedAt).toBeNull();
  });

  it('skips Whisper for a video that is all silence', async () => {
    extract.mockResolvedValue(null);

    await service.caption(media);

    expect(transcription.transcribe).not.toHaveBeenCalled();
    expect((await reload(media.id))?.captionStatus).toBe(
      CaptionStatus.NO_SPEECH,
    );
  });

  it('replaces an earlier track of the same language and keeps the others', async () => {
    const old = { languageCode: 'vi', name: 'x', isOriginal: true, url: 'old' };
    const other = { ...old, languageCode: 'fr', url: 'fr' };
    media = await addMedia({ captions: [old, other] });

    await service.caption(media);

    const captions = (await reload(media.id))?.captions ?? [];
    expect(captions.map(({ languageCode }) => languageCode)).toEqual([
      'fr',
      'vi',
      'en',
    ]);
    expect(
      captions.find(({ languageCode }) => languageCode === 'vi')?.url,
    ).toBe('https://cdn/vi.vtt');
  });

  it('keeps the spoken captions when the translation fails', async () => {
    transcription.translate.mockRejectedValue(new Error('bad JSON'));

    await service.caption(media);

    const stored = await reload(media.id);
    expect(stored?.captions).toHaveLength(1);
    expect(stored?.captionStatus).toBe(CaptionStatus.READY);
  });

  it('marks the video FAILED when transcription fails', async () => {
    transcription.transcribe.mockRejectedValue(new Error('503'));

    await service.caption(media);

    expect((await reload(media.id))?.captionStatus).toBe(CaptionStatus.FAILED);
  });

  it('does nothing when another run already claimed the video', async () => {
    await assets().updateOne(
      { _id: media.id },
      { $set: { captionStatus: CaptionStatus.TRANSCRIBING } },
    );

    await service.caption(media);

    expect(extract).not.toHaveBeenCalled();
  });

  it('captions a video once when two runs race for it', async () => {
    await Promise.all([service.caption(media), service.caption(media)]);

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('drains only videos of published posts', async () => {
    const author = await createUser(db);
    const published = await createPost(db, { authorId: author.id });
    const hidden = await createPost(db, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      publishedAt: null,
    });
    const visible = await addMedia({ postId: published.id });
    const other = await addMedia({ postId: hidden.id });

    await service.drain();

    expect((await reload(visible.id))?.captionStatus).toBe(CaptionStatus.READY);
    expect((await reload(other.id))?.captionStatus).toBe(CaptionStatus.NONE);
  });

  it('lets captioning that a restart cut off be picked up again', async () => {
    await assets().updateOne(
      { _id: media.id },
      {
        $set: {
          captionStatus: CaptionStatus.TRANSCRIBING,
          updatedAt: new Date(Date.now() - 31 * 60_000),
        },
      },
      { timestamps: false },
    );

    await service.releaseStale();

    expect((await reload(media.id))?.captionStatus).toBe(CaptionStatus.NONE);
  });

  describe('backfillTranscripts', () => {
    const track = { url: 'https://cdn/vi.vtt', isOriginal: true };
    let fetchMock: ReturnType<typeof vi.fn>;
    let postId: string;

    beforeEach(async () => {
      const author = await createUser(db);
      const post = await createPost(db, {
        authorId: author.id,
        searchIndexedAt: new Date(),
      });
      postId = post.id;
      media = await addMedia({
        postId,
        captionStatus: CaptionStatus.READY,
        captions: [{ ...track, languageCode: 'vi', name: 'Tiếng Việt' }],
      });
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('stores the spoken track as text and marks the post for embedding', async () => {
      fetchMock.mockResolvedValue(
        new Response('WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nXin chào\n'),
      );

      await service.backfillTranscripts();

      expect(fetchMock).toHaveBeenCalledWith(track.url, expect.anything());
      expect((await reload(media.id))?.transcript).toBe('Xin chào');
      expect(
        (await posts().findById(postId).exec())?.searchIndexedAt,
      ).toBeNull();
    });

    it('leaves the transcript empty for the next run when the download fails', async () => {
      fetchMock.mockResolvedValue(new Response('gone', { status: 404 }));

      await service.backfillTranscripts();

      expect((await reload(media.id))?.transcript).toBeNull();
      expect(
        (await posts().findById(postId).exec())?.searchIndexedAt,
      ).toBeInstanceOf(Date);
    });
  });
});
