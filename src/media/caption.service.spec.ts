import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CaptionStatus } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { CaptionService } from './caption.service';
import * as speechAudio from './captions/speech-audio';
import { TranscriptionService } from './captions/transcription.service';
import { mediaId, pendingMedia } from './media.fixtures';

vi.mock('./captions/speech-audio', async (importOriginal) => ({
  ...(await importOriginal<typeof speechAudio>()),
  extractSpeechAudio: vi.fn(),
}));

describe('CaptionService', () => {
  let service: CaptionService;
  let prisma: DeepMockProxy<PrismaService>;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let transcription: DeepMockProxy<TranscriptionService>;
  const extract = vi.mocked(speechAudio.extractSpeechAudio);
  const cues = [{ start: 5, end: 8, text: 'Xin chào' }];

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    cloudinary = mockDeep<CloudinaryService>();
    transcription = mockDeep<TranscriptionService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CaptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: TranscriptionService, useValue: transcription },
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    service = moduleRef.get(CaptionService);

    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 1 });
    cloudinary.originalUrl.mockReturnValue('https://cdn/original');
    cloudinary.uploadCaption.mockImplementation((_id, language) =>
      Promise.resolve(`https://cdn/${language}.vtt`),
    );
    extract.mockReset();
    extract.mockResolvedValue({
      audio: Buffer.from('mp3'),
      speech: [{ start: 5, end: 8 }],
    });
    transcription.transcribe.mockResolvedValue({ language: 'vi', cues });
    transcription.translate.mockResolvedValue([{ ...cues[0], text: 'Hello' }]);
  });

  it('stores the spoken captions and their English translation', async () => {
    await service.caption(pendingMedia);

    expect(extract).toHaveBeenCalledWith('https://cdn/original', 42);
    expect(transcription.translate).toHaveBeenCalledWith(cues, 'vi', 'en');
    const tracks = prisma.mediaCaption.upsert.mock.calls.map(
      ([call]) => call.create,
    );
    expect(tracks).toEqual([
      {
        mediaId,
        languageCode: 'vi',
        name: 'Tiếng Việt',
        isOriginal: true,
        url: 'https://cdn/vi.vtt',
      },
      {
        mediaId,
        languageCode: 'en',
        name: 'English',
        isOriginal: false,
        url: 'https://cdn/en.vtt',
      },
    ]);
    const [done] = prisma.mediaAsset.updateMany.mock.calls.at(-1)!;
    expect(done.data).toEqual({
      captionStatus: CaptionStatus.READY,
      captionLanguage: 'vi',
    });
  });

  it('skips Whisper for a video that is all silence', async () => {
    extract.mockResolvedValue(null);

    await service.caption(pendingMedia);

    expect(transcription.transcribe).not.toHaveBeenCalled();
    const [done] = prisma.mediaAsset.updateMany.mock.calls.at(-1)!;
    expect(done.data).toEqual({ captionStatus: CaptionStatus.NO_SPEECH });
  });

  it('keeps the spoken captions when the translation fails', async () => {
    transcription.translate.mockRejectedValue(new Error('bad JSON'));

    await service.caption(pendingMedia);

    expect(prisma.mediaCaption.upsert).toHaveBeenCalledTimes(1);
    const [done] = prisma.mediaAsset.updateMany.mock.calls.at(-1)!;
    expect(done.data.captionStatus).toBe(CaptionStatus.READY);
  });

  it('marks the video FAILED when transcription fails', async () => {
    transcription.transcribe.mockRejectedValue(new Error('503'));

    await service.caption(pendingMedia);

    const [done] = prisma.mediaAsset.updateMany.mock.calls.at(-1)!;
    expect(done.data).toEqual({ captionStatus: CaptionStatus.FAILED });
  });

  it('does nothing when another run already claimed the video', async () => {
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });

    await service.caption(pendingMedia);

    expect(extract).not.toHaveBeenCalled();
  });
});
