import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceException } from '../../../../src/common/exceptions/external-service.exception.js';
import * as ffmpegModule from '../../../../src/common/ffmpeg/ffmpeg.js';
import {
  extractSpeechAudio,
  parseSilences,
  speechIntervals,
  toOriginalTime,
} from '../../../../src/media/captions/speech-audio.js';

vi.mock('../../../../src/common/ffmpeg/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ffmpegModule>();
  return {
    ...actual,
    runFfmpeg: vi.fn(),
  };
});

describe('speech-audio', () => {
  const runFfmpeg = vi.mocked(ffmpegModule.runFfmpeg);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runFfmpeg.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('pure helpers', () => {
    it('clamps negative silence start times to zero and ignores orphan silence_end', () => {
      const log = [
        'silence_end: 1.5',
        'silence_start: -0.25',
        'silence_end: 2.0',
      ].join('\n');
      expect(parseSilences(log, 10)).toEqual([{ start: 0, end: 2.0 }]);
    });

    it('drops speech segments shorter than 0.3s', () => {
      expect(
        speechIntervals(
          [
            { start: 0, end: 2.0 },
            { start: 2.2, end: 5.0 },
          ],
          5.0,
        ),
      ).toEqual([]);
    });

    it('returns the input time unchanged when speech intervals are empty', () => {
      expect(toOriginalTime([], 4.2)).toBe(4.2);
    });
  });

  describe('extractSpeechAudio', () => {
    it('downloads the video, detects silences, cuts non-speech, and returns mp3 + intervals', async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      );
      const wav = Buffer.from('riff-wav');
      const mp3 = Buffer.from('cut-mp3');
      runFfmpeg
        .mockResolvedValueOnce({
          stdout: wav,
          stderr: [
            '[silencedetect] silence_start: 0',
            '[silencedetect] silence_end: 2.0',
            '[silencedetect] silence_start: 6.0',
            '[silencedetect] silence_end: 10.0',
          ].join('\n'),
        })
        .mockResolvedValueOnce({
          stdout: mp3,
          stderr: '',
        });

      const result = await extractSpeechAudio('https://cdn/video.mp4', 10);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cdn/video.mp4');
      expect(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal,
      ).toBeInstanceOf(AbortSignal);
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      const firstArgs = runFfmpeg.mock.calls[0]?.[0] ?? [];
      expect(firstArgs).toContain('silencedetect=noise=-35dB:duration=0.6');
      const secondCall = runFfmpeg.mock.calls[1];
      expect(secondCall?.[0]).toContain(
        "aselect='between(t,1.800,6.200)',asetpts=N/SR/TB",
      );
      expect(secondCall?.[1]).toEqual(wav);
      expect(result).toEqual({
        audio: mp3,
        speech: [{ start: 1.8, end: 6.2 }],
      });
    });

    it('throws ExternalServiceException when downloading fails or body is missing', async () => {
      fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
      await expect(
        extractSpeechAudio('https://cdn/missing.mp4', 10),
      ).rejects.toBeInstanceOf(ExternalServiceException);

      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null });
      await expect(
        extractSpeechAudio('https://cdn/nobody.mp4', 10),
      ).rejects.toBeInstanceOf(ExternalServiceException);
    });

    it.each([
      'Output file #0 does not contain any stream',
      'Stream specifier :a:0 in filtergraph matches no streams',
    ])(
      'returns null when the video has no audio stream (%s)',
      async (stderr) => {
        fetchMock.mockResolvedValue(
          new Response(new Uint8Array([1, 2]), { status: 200 }),
        );
        runFfmpeg.mockRejectedValue(
          new ffmpegModule.FfmpegError('ffmpeg failed', stderr),
        );

        await expect(
          extractSpeechAudio('https://cdn/muted.mp4', 10),
        ).resolves.toBeNull();
      },
    );

    it('rethrows unexpected ffmpeg errors', async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([1, 2]), { status: 200 }),
      );
      runFfmpeg.mockRejectedValue(
        new ffmpegModule.FfmpegError('corrupt', 'Invalid data found'),
      );

      await expect(
        extractSpeechAudio('https://cdn/bad.mp4', 10),
      ).rejects.toBeInstanceOf(ffmpegModule.FfmpegError);
    });

    it('returns null without running the cut pass when the whole audio is silent', async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([1, 2]), { status: 200 }),
      );
      runFfmpeg.mockResolvedValueOnce({
        stdout: Buffer.from('wav'),
        stderr:
          '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 10.0',
      });

      await expect(
        extractSpeechAudio('https://cdn/silent.mp4', 10),
      ).resolves.toBeNull();
      expect(runFfmpeg).toHaveBeenCalledTimes(1);
    });
  });
});
