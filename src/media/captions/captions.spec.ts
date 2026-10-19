import { parseSilences, speechIntervals, toOriginalTime } from './speech-audio';
import {
  languageCode,
  languageName,
  splitLongCue,
  translationTarget,
} from './transcription.service';
import { toVtt } from './vtt';

describe('silence removal', () => {
  const log = [
    '[silencedetect @ 0x1] silence_start: 0',
    '[silencedetect @ 0x1] silence_end: 5.1 | silence_duration: 5.1',
    '[silencedetect @ 0x1] silence_start: 9.46',
    '[silencedetect @ 0x1] silence_end: 9.96 | silence_duration: 0.5',
    '[silencedetect @ 0x1] silence_start: 12.68',
  ].join('\n');

  it('reads silences, including one that runs to the end', () => {
    expect(parseSilences(log, 20)).toEqual([
      { start: 0, end: 5.1 },
      { start: 9.46, end: 9.96 },
      { start: 12.68, end: 20 },
    ]);
  });

  it('keeps the speech between silences, padded', () => {
    const speech = speechIntervals(parseSilences(log, 20), 20);
    expect(speech).toHaveLength(2);
    expect(speech[0].start).toBeCloseTo(4.9);
    expect(speech[0].end).toBeCloseTo(9.66);
    expect(speech[1].start).toBeCloseTo(9.76);
    expect(speech[1].end).toBeCloseTo(12.88);
  });

  it('merges speech whose padding overlaps', () => {
    expect(
      speechIntervals(
        [
          { start: 2, end: 2.3 },
          { start: 5, end: 10 },
        ],
        10,
      ),
    ).toEqual([{ start: 0, end: 5.2 }]);
  });

  it('finds no speech in a silent file', () => {
    expect(speechIntervals([{ start: 0, end: 10 }], 10)).toEqual([]);
  });

  it('keeps the whole file when nothing is silent', () => {
    expect(speechIntervals([], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('maps times in the cut audio back onto the video', () => {
    const speech = [
      { start: 2, end: 4 },
      { start: 10, end: 13 },
    ];
    expect(toOriginalTime(speech, 1)).toBe(3);
    expect(toOriginalTime(speech, 2.5)).toBe(10.5);
    expect(toOriginalTime(speech, 99)).toBe(13);
  });
});

describe('cues', () => {
  it('splits a long cue at sentence breaks, by length', () => {
    const parts = splitLongCue({
      start: 0,
      end: 10,
      text: 'Cắt đậu hũ. Chiên vàng đều hai mặt!',
    });
    expect(parts.map(({ text }) => text)).toEqual([
      'Cắt đậu hũ.',
      'Chiên vàng đều hai mặt!',
    ]);
    expect(parts[0].end).toBe(parts[1].start);
    expect(parts[1].end).toBe(10);
  });

  it('writes WebVTT', () => {
    expect(toVtt([{ start: 61.5, end: 63, text: 'a --> b' }])).toBe(
      'WEBVTT\n\n00:01:01.500 --> 00:01:03.000\na → b\n',
    );
  });
});

describe('languages', () => {
  it('normalizes the language Whisper reports', () => {
    expect(languageCode('vi')).toBe('vi');
    expect(languageCode('Vietnamese')).toBe('vi');
    expect(languageCode('en-US')).toBe('en');
  });

  it('translates Vietnamese to English and the rest to Vietnamese', () => {
    expect(translationTarget('vi')).toBe('en');
    expect(translationTarget('en')).toBe('vi');
    expect(translationTarget('ja')).toBe('vi');
  });

  it('names languages in themselves', () => {
    expect(languageName('vi')).toBe('Tiếng Việt');
    expect(languageName('en')).toBe('English');
    expect(languageName('vi', 'en')).toBe('Vietnamese');
  });
});
