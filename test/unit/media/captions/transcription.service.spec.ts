import type { AiService } from '@nestjs/ai';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCostTransportService } from '../../../../src/ai/telemetry/ai-cost-transport.service.js';
import { ExternalServiceException } from '../../../../src/common/exceptions/external-service.exception.js';
import {
  TranscriptionService,
  languageCode,
  languageName,
  splitLongCue,
} from '../../../../src/media/captions/transcription.service.js';

describe('TranscriptionService', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let generateObject: ReturnType<typeof vi.fn>;
  let service: TranscriptionService;

  beforeEach(() => {
    fetchSpy = vi.fn();
    generateObject = vi.fn();
    const config = new ConfigService({
      OPENROUTER_API_KEY: 'or-key',
      TRANSCRIPTION_MODEL: 'openai/whisper-large-v3',
    });
    service = new TranscriptionService(
      config,
      { generateObject } as unknown as AiService,
      { fetch: fetchSpy } as unknown as AiCostTransportService,
    );
  });

  describe('transcribe', () => {
    it('builds cues from word timings, maps timestamps, filters noise/hallucinations, and splits long cues', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            text: 'ignored when words present',
            language: 'Vietnamese',
            words: [
              { word: 'Xin', start: 0.0, end: 0.4 },
              { word: 'chào', start: 0.4, end: 0.8 },
              { word: 'mọi', start: 0.8, end: 1.2 },
              { word: 'người.', start: 1.2, end: 1.6 },
              // pause > 0.8s triggers new cue, hallucination filtered out
              { word: 'Đăng', start: 3.0, end: 3.3 },
              { word: 'ký', start: 3.3, end: 3.6 },
              { word: 'kênh.', start: 3.6, end: 4.0 },
              // non-letter cue filtered out
              { word: '123!', start: 5.0, end: 5.2 },
              // zero-duration cue filtered out
              { word: 'nope', start: 6.0, end: 6.0 },
              // long multi-sentence cue (>7s) split into sentences
              { word: 'Cắt', start: 7.5, end: 8.0 },
              { word: 'đậu.', start: 8.0, end: 11.5 },
              { word: 'Chiên', start: 11.6, end: 12.5 },
              { word: 'vàng!', start: 12.6, end: 15.5 },
            ],
          }),
          { status: 200 },
        ),
      );

      const transcript = await service.transcribe({
        audio: Buffer.from('mp3-bytes'),
        speech: [
          { start: 10, end: 16 },
          { start: 20, end: 30 },
        ],
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer or-key',
            'Content-Type': 'application/json',
          },
        }),
      );
      expect(transcript.language).toBe('vi');
      expect(transcript.cues).toHaveLength(3);
      expect(transcript.cues[0]).toEqual({
        start: 10,
        end: 11.6,
        text: 'Xin chào mọi người.',
      });
      expect(transcript.cues[1]?.text).toBe('Cắt đậu.');
      expect(transcript.cues[2]?.text).toBe('Chiên vàng!');
      expect(transcript.cues[1]?.start).toBeCloseTo(21.5);
      expect(transcript.cues[2]?.end).toBeCloseTo(29.5);
    });

    it('falls back to segments and filters high no_speech_prob and low avg_logprob', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            text: 'fallback',
            language: 'en-US',
            segments: [
              {
                start: 0,
                end: 2,
                text: '  Stir   the   soup  ',
                no_speech_prob: 0.1,
                avg_logprob: -0.3,
              },
              {
                start: 2,
                end: 4,
                text: 'Silence noise',
                no_speech_prob: 0.7,
                avg_logprob: -0.2,
              },
              {
                start: 4,
                end: 6,
                text: 'Garbled audio',
                no_speech_prob: 0.1,
                avg_logprob: -1.5,
              },
              {
                start: 6,
                end: 8,
                text: 'Thanks for watching!',
                no_speech_prob: 0.0,
                avg_logprob: -0.1,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const transcript = await service.transcribe({
        audio: Buffer.from('mp3'),
        speech: [{ start: 2, end: 10 }],
      });

      expect(transcript).toEqual({
        language: 'en',
        cues: [{ start: 2, end: 4, text: 'Stir the soup' }],
      });
    });

    it('falls back to full-length text cue when words and segments are absent', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            text: 'Add tofu and simmer',
          }),
          { status: 200 },
        ),
      );

      const transcript = await service.transcribe({
        audio: Buffer.from('mp3'),
        speech: [{ start: 1, end: 5 }],
      });

      expect(transcript).toEqual({
        language: '',
        cues: [{ start: 1, end: 5, text: 'Add tofu and simmer' }],
      });
    });

    it('throws ExternalServiceException with error details on non-OK HTTP responses', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'rate limited' } }),
          { status: 429 },
        ),
      );

      await expect(
        service.transcribe({
          audio: Buffer.from('mp3'),
          speech: [{ start: 0, end: 2 }],
        }),
      ).rejects.toMatchObject({
        constructor: ExternalServiceException,
        reason: 'Transcription answered 429: rate limited',
      });

      fetchSpy.mockResolvedValue(new Response('not json', { status: 502 }));
      await expect(
        service.transcribe({
          audio: Buffer.from('mp3'),
          speech: [{ start: 0, end: 2 }],
        }),
      ).rejects.toMatchObject({
        constructor: ExternalServiceException,
        reason: 'Transcription answered 502',
      });
    });

    it('throws ExternalServiceException when OpenRouter returns an invalid payload shape', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ wrong: true }), { status: 200 }),
      );

      await expect(
        service.transcribe({
          audio: Buffer.from('mp3'),
          speech: [{ start: 0, end: 2 }],
        }),
      ).rejects.toBeInstanceOf(ExternalServiceException);
    });
  });

  describe('translate', () => {
    const cues = [
      { start: 0, end: 2, text: 'Xin chào' },
      { start: 2, end: 4, text: 'Vedora ngon' },
    ];

    it('translates cue lines in order and preserves timestamps', async () => {
      generateObject.mockResolvedValue({
        object: { lines: ['  Hello  ', '  Vedora delicious  '] },
      });

      const translated = await service.translate(cues, 'vi', 'en');

      expect(generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'translate-captions',
          prompt: JSON.stringify(['Xin chào', 'Vedora ngon']),
        }),
      );
      expect(translated).toEqual([
        { start: 0, end: 2, text: 'Hello' },
        { start: 2, end: 4, text: 'Vedora delicious' },
      ]);
    });

    it('throws ExternalServiceException when translation line count mismatches cues', async () => {
      generateObject.mockResolvedValue({
        object: { lines: ['Only one line'] },
      });

      await expect(service.translate(cues, 'vi', 'en')).rejects.toBeInstanceOf(
        ExternalServiceException,
      );
    });
  });

  describe('helper edge cases', () => {
    it('keeps a long single-sentence cue intact', () => {
      const cue = { start: 0, end: 9, text: 'Just one long sentence.' };
      expect(splitLongCue(cue)).toEqual([cue]);
    });

    it('falls back gracefully for unknown or invalid language tags', () => {
      expect(languageCode('pt-BR')).toBe('pt');
      expect(languageName('invalid_tag_12345')).toBe('invalid_tag_12345');
    });
  });
});
