import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Mux, { BadRequestError, InternalServerError } from '@mux/ts';
import type { Asset } from '@mux/ts/resources/video/assets';
import type { GeneratePremiumCaptionsJob } from '@mux/ts/resources/robots/jobs/generate-premium-captions';
import type { TranslateCaptionsJob } from '@mux/ts/resources/robots/jobs/translate-captions';
import { CaptionStatus, MediaAsset, MediaStatus } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CaptionService,
  languageName,
  srtHasSpeech,
  translationTarget,
} from './caption.service';
import { mediaId, pendingMedia } from './media.fixtures';

const readyMedia: MediaAsset = {
  ...pendingMedia,
  status: MediaStatus.READY,
  playbackId: 'playback-1',
};

const speechSrt = `1
00:00:00,180 --> 00:00:02,560
Bạn chỉ cần cho ba miếng tàu hủ trắng vào
tô rồi bóp nhuyễn.
`;

function generationJob(
  overrides: Partial<GeneratePremiumCaptionsJob> = {},
): GeneratePremiumCaptionsJob {
  return {
    id: 'job-1',
    created_at: 0,
    updated_at: 0,
    units_consumed: 242,
    workflow: 'generate-premium-captions',
    parameters: { asset_id: 'asset-1' },
    status: 'completed',
    outputs: {
      language_code: 'vi',
      detected_language: 'vi',
      auto_language_confidence: 0.99,
      temporary_srt_url: 'https://mux.example/captions.srt',
    },
    ...overrides,
  };
}

function translationJob(
  status: TranslateCaptionsJob['status'],
): TranslateCaptionsJob {
  return {
    id: 'job-2',
    created_at: 0,
    updated_at: 0,
    units_consumed: 342,
    workflow: 'translate-captions',
    parameters: {
      asset_id: 'asset-1',
      track_id: 'track-1',
      to_language_code: 'en',
    },
    status,
  };
}

function assetWithTrack(status: 'preparing' | 'ready' | 'errored'): Asset {
  return {
    id: 'asset-1',
    created_at: '0',
    encoding_tier: 'baseline',
    master_access: 'none',
    max_resolution_tier: '1080p',
    status: 'ready',
    tracks: [{ id: 'track-1', type: 'text', status }],
  } as Asset;
}

describe('CaptionService', () => {
  let service: CaptionService;
  let prisma: DeepMockProxy<PrismaService>;
  let muxClient: DeepMockProxy<Mux>;
  const fetchMock = vi.fn<typeof fetch>();

  async function build(enabled = true) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CaptionService,
        MuxService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MUX_TOKEN_ID: 'id',
            MUX_TOKEN_SECRET: 'secret',
            MUX_CAPTIONS_ENABLED: enabled,
          }),
        },
      ],
    }).compile();
    vi.spyOn(moduleRef.get(MuxService), 'require').mockReturnValue(muxClient);
    return moduleRef.get(CaptionService);
  }

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    muxClient = mockDeep<Mux>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(speechSrt));
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 1 });
    service = await build();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('start', () => {
    beforeEach(() => {
      prisma.mediaAsset.findMany.mockResolvedValue([readyMedia]);
      muxClient.robots.jobs.generatePremiumCaptions.create.mockResolvedValue(
        generationJob({ status: 'pending', outputs: undefined }),
      );
    });

    it('claims the video and starts a caption job with language detection', async () => {
      await service.start({ post: { id: 'post-1' } });

      expect(prisma.mediaAsset.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: mediaId, captionStatus: CaptionStatus.NONE },
        data: { captionStatus: CaptionStatus.GENERATING },
      });
      const [body] =
        muxClient.robots.jobs.generatePremiumCaptions.create.mock.calls[0];
      expect(body.parameters).toMatchObject({
        asset_id: 'asset-1',
        upload_to_mux: false,
      });
      expect(body.parameters).not.toHaveProperty('language_code');
      expect(body.passthrough).toBe(mediaId);
      expect(prisma.mediaAsset.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: mediaId, captionStatus: CaptionStatus.GENERATING },
        data: { captionJobId: 'job-1' },
      });
    });

    it('does nothing while captions are disabled', async () => {
      service = await build(false);

      await service.start();

      expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    });

    it('skips a video another caller already claimed', async () => {
      prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });

      await service.start();

      expect(
        muxClient.robots.jobs.generatePremiumCaptions.create,
      ).not.toHaveBeenCalled();
    });

    it('gives up when Mux refuses the job', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.create.mockRejectedValue(
        new BadRequestError(400, {}, 'no audio', new Headers()),
      );

      await service.start();

      const [, revert] = prisma.mediaAsset.updateMany.mock.calls;
      expect(revert[0].data).toEqual({ captionStatus: CaptionStatus.FAILED });
    });

    it('releases the claim for a retry when Mux is down', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.create.mockRejectedValue(
        new InternalServerError(503, {}, 'unavailable', new Headers()),
      );

      await service.start();

      const [, revert] = prisma.mediaAsset.updateMany.mock.calls;
      expect(revert[0].data).toEqual({ captionStatus: CaptionStatus.NONE });
    });
  });

  describe('when generation ends', () => {
    const generating = {
      ...readyMedia,
      captionStatus: CaptionStatus.GENERATING,
      captionJobId: 'job-1',
    };

    it('attaches the captions under their own language name', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.retrieve.mockResolvedValue(
        generationJob(),
      );
      muxClient.video.assets.createTrack.mockResolvedValue({ id: 'track-1' });

      await service.advance(generating);

      expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
        where: {
          id: mediaId,
          captionStatus: CaptionStatus.GENERATING,
          captionJobId: 'job-1',
        },
        data: {
          captionStatus: CaptionStatus.ATTACHING,
          captionJobId: null,
          captionLanguage: 'vi',
        },
      });
      expect(muxClient.video.assets.createTrack).toHaveBeenCalledWith(
        'asset-1',
        {
          url: 'https://mux.example/captions.srt',
          type: 'text',
          text_type: 'subtitles',
          language_code: 'vi',
          name: 'Tiếng Việt',
        },
      );
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        where: { id: mediaId },
        data: { captionTrackId: 'track-1' },
      });
    });

    it('attaches nothing to a clip without speech', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.retrieve.mockResolvedValue(
        generationJob(),
      );
      fetchMock.mockResolvedValue(
        new Response('1\n00:00:00,060 --> 00:00:15,000\n[beep]\n'),
      );

      await service.advance(generating);

      const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(update.data).toEqual({
        captionStatus: CaptionStatus.NO_SPEECH,
        captionJobId: null,
      });
      expect(muxClient.video.assets.createTrack).not.toHaveBeenCalled();
    });

    it('treats a low-confidence language guess as no speech', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.retrieve.mockResolvedValue(
        generationJob({
          outputs: {
            language_code: 'sh',
            auto_language_confidence: 0.4,
            temporary_srt_url: 'https://mux.example/captions.srt',
          },
        }),
      );

      await service.advance(generating);

      const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(update.data.captionStatus).toBe(CaptionStatus.NO_SPEECH);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails the captions when the job errored', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.retrieve.mockResolvedValue(
        generationJob({ status: 'errored', outputs: undefined }),
      );

      await service.advance(generating);

      const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(update.data).toEqual({
        captionStatus: CaptionStatus.FAILED,
        captionJobId: null,
      });
    });

    it('waits while the job is still running', async () => {
      muxClient.robots.jobs.generatePremiumCaptions.retrieve.mockResolvedValue(
        generationJob({ status: 'processing', outputs: undefined }),
      );

      await service.advance(generating);

      expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('translation', () => {
    const attaching = {
      ...readyMedia,
      captionStatus: CaptionStatus.ATTACHING,
      captionLanguage: 'vi',
      captionTrackId: 'track-1',
    };

    it('translates Vietnamese captions to English once the track is ready', async () => {
      muxClient.video.assets.retrieve.mockResolvedValue(
        assetWithTrack('ready'),
      );
      muxClient.robots.jobs.translateCaptions.create.mockResolvedValue(
        translationJob('pending'),
      );

      await service.advance(attaching);

      const [body] = muxClient.robots.jobs.translateCaptions.create.mock.calls[0];
      expect(body.parameters).toMatchObject({
        asset_id: 'asset-1',
        track_id: 'track-1',
        to_language_code: 'en',
      });
      expect(prisma.mediaAsset.updateMany).toHaveBeenLastCalledWith({
        where: { id: mediaId, captionStatus: CaptionStatus.TRANSLATING },
        data: { captionJobId: 'job-2' },
      });
    });

    it('waits while Mux is still preparing the track', async () => {
      muxClient.video.assets.retrieve.mockResolvedValue(
        assetWithTrack('preparing'),
      );

      await service.advance(attaching);

      expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
      expect(
        muxClient.robots.jobs.translateCaptions.create,
      ).not.toHaveBeenCalled();
    });

    it('keeps the original captions when the translation cannot start', async () => {
      muxClient.video.assets.retrieve.mockResolvedValue(
        assetWithTrack('ready'),
      );
      muxClient.robots.jobs.translateCaptions.create.mockRejectedValue(
        new InternalServerError(500, {}, 'boom', new Headers()),
      );

      await service.advance(attaching);

      expect(prisma.mediaAsset.updateMany).toHaveBeenLastCalledWith({
        where: { id: mediaId, captionStatus: CaptionStatus.TRANSLATING },
        data: { captionStatus: CaptionStatus.READY },
      });
    });

    it.each(['completed', 'errored'] as const)(
      'marks captions READY when the translation %s',
      async (status) => {
        muxClient.robots.jobs.translateCaptions.retrieve.mockResolvedValue(
          translationJob(status),
        );

        await service.advance({
          ...readyMedia,
          captionStatus: CaptionStatus.TRANSLATING,
          captionJobId: 'job-2',
        });

        expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
          where: {
            id: mediaId,
            captionStatus: CaptionStatus.TRANSLATING,
            captionJobId: 'job-2',
          },
          data: { captionStatus: CaptionStatus.READY, captionJobId: null },
        });
      },
    );
  });
});

describe('caption helpers', () => {
  it('finds speech only outside sound tags', () => {
    expect(srtHasSpeech(speechSrt)).toBe(true);
    expect(srtHasSpeech('1\n00:00:00,040 --> 00:00:15,000\n[pause]\n')).toBe(
      false,
    );
    expect(srtHasSpeech('1\n00:00:00,000 --> 00:00:02,000\n(music)\n')).toBe(
      false,
    );
  });

  it('translates Vietnamese to English and everything else to Vietnamese', () => {
    expect(translationTarget('vi')).toBe('en');
    expect(translationTarget('vi-VN')).toBe('en');
    expect(translationTarget('en')).toBe('vi');
  });

  it('names languages in their own language', () => {
    expect(languageName('vi')).toBe('Tiếng Việt');
    expect(languageName('en')).toBe('English');
    expect(languageName('not a tag')).toBe('not a tag');
  });
});
