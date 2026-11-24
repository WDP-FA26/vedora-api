import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import type { OpenRouter } from '@openrouter/sdk';
import type { STTWord } from '@openrouter/sdk/models';
import { PromptCache } from '../../ai/prompt-cache.js';
import {
  createOpenRouterClient,
  openRouterFailure,
} from '../../ai/openrouter-client.js';
import { AiCostTransportService } from '../../ai/telemetry/ai-cost-transport.service.js';
import { z } from 'zod';
import { ExternalServiceException } from '../../common/exceptions/external-service.exception.js';
import { type SpeechAudio, toOriginalTime } from './speech-audio.js';
import type { Cue } from './vtt.js';

const TRANSCRIBE_TIMEOUT_MS = runtimeConfig.TRANSCRIPTION_TIMEOUT_MS;

const CAPTION_PROMPT =
  'Vedora, tàu hủ, đậu hũ, chao, nấm mèo, bún tàu, hạt nêm, dầu điều, nước tương, mắm chay, tempeh, seitan.';
const NEVER_TRANSLATE = ['Vedora'];

const MAX_NO_SPEECH_PROB = runtimeConfig.TRANSCRIPTION_MAX_NO_SPEECH_PROB;
const MIN_AVG_LOGPROB = runtimeConfig.TRANSCRIPTION_MIN_AVG_LOGPROB;
const HALLUCINATIONS = [
  /ghiền mì gõ/i,
  /đăng ký kênh/i,
  /subscribe cho kênh/i,
  /thanks for watching/i,
];
const MAX_CUE_SEC = runtimeConfig.CAPTION_MAX_CUE_SECONDS;

const CUE_GAP_SEC = runtimeConfig.CAPTION_CUE_GAP_SECONDS;

const LANGUAGE_CODES: Record<string, string> = {
  vietnamese: 'vi',
  vie: 'vi',
  english: 'en',
  eng: 'en',
  chinese: 'zh',
  zho: 'zh',
  cmn: 'zh',
  japanese: 'ja',
  jpn: 'ja',
  korean: 'ko',
  kor: 'ko',
  french: 'fr',
  fra: 'fr',
  german: 'de',
  deu: 'de',
  spanish: 'es',
  spa: 'es',
  thai: 'th',
  tha: 'th',
  indonesian: 'id',
  ind: 'id',
};

const translationOutput = z.object({ lines: z.array(z.string()) });

interface TimedText extends Cue {
  noSpeechProb?: number;
  avgLogprob?: number;
}

export interface Transcript {
  language: string;
  cues: Cue[];
}

@Injectable()
export class TranscriptionService {
  private readonly openrouter: OpenRouter;
  private readonly transcriptionModel: string;

  constructor(
    configService: ConfigService,
    private readonly ai: AiService,
    costs: AiCostTransportService,
  ) {
    this.openrouter = createOpenRouterClient(
      configService.getOrThrow<string>('OPENROUTER_API_KEY'),
      costs.fetch,
    );
    this.transcriptionModel = configService.get<string>(
      'TRANSCRIPTION_MODEL',
      'elevenlabs/scribe-v2',
    );
  }

  async transcribe({ audio, speech }: SpeechAudio): Promise<Transcript> {
    const result = await this.openrouter.stt
      .createTranscription(
        {
          sttRequest: {
            model: this.transcriptionModel,
            inputAudio: { data: audio.toString('base64'), format: 'mp3' },
            responseFormat: 'verbose_json',
            timestampGranularities: ['word'],
            prompt: CAPTION_PROMPT,
            temperature: 0,
          },
        },
        { signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) },
      )
      .catch((error: unknown) => {
        throw openRouterFailure('Transcription', error);
      });
    const audioEnd = speech.reduce(
      (sum, { start, end }) => sum + end - start,
      0,
    );
    const timed: TimedText[] = result.words?.length
      ? cuesFromWords(result.words)
      : (result.segments ?? [{ start: 0, end: audioEnd, text: result.text }]);

    const cues = timed
      .filter(
        (segment) =>
          (segment.noSpeechProb ?? 0) <= MAX_NO_SPEECH_PROB &&
          (segment.avgLogprob ?? 0) >= MIN_AVG_LOGPROB &&
          !HALLUCINATIONS.some((pattern) => pattern.test(segment.text)),
      )
      .map((segment) => ({
        start: toOriginalTime(speech, segment.start),
        end: toOriginalTime(speech, Math.min(segment.end, audioEnd)),
        text: segment.text.replace(/\s+/g, ' ').trim(),
      }))
      .filter((cue) => /\p{L}/u.test(cue.text) && cue.end > cue.start)
      .flatMap(splitLongCue);
    return { language: languageCode(result.language ?? ''), cues };
  }

  async translate(cues: Cue[], from: string, to: string): Promise<Cue[]> {
    const { object } = await this.ai.generateObject({
      label: 'translate-captions',
      instructions: `You translate video captions about plant-based cooking from ${languageName(from, 'en')} to ${languageName(to, 'en')}. Return exactly one translated line per input line, in the same order, as {"lines": [...]}. Keep these words unchanged: ${NEVER_TRANSLATE.join(', ')}. Never merge, split or skip lines.`,
      prompt: JSON.stringify(cues.map((cue) => cue.text)),
      providerOptions: PromptCache.sticky('vedora-caption-translate', from, to),
      schema: translationOutput,
      timeout: '2m',
    });
    if (object.lines.length !== cues.length) {
      throw new ExternalServiceException(
        'openrouter',
        `Translation returned ${object.lines.length} lines for ${cues.length} cues`,
      );
    }
    return cues.map((cue, index) => ({
      ...cue,
      text: object.lines[index].trim(),
    }));
  }
}

export function cuesFromWords(words: STTWord[]): Cue[] {
  const cues: Cue[] = [];
  let current: STTWord[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last) {
      cues.push({
        start: first.start,
        end: last.end,
        text: current.map(({ word }) => word).join(' '),
      });
    }
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    const paused =
      previous !== undefined && word.start - previous.end > CUE_GAP_SEC;
    const tooLong =
      current[0] !== undefined && word.end - current[0].start > MAX_CUE_SEC;
    if (paused || tooLong) flush();
    current.push(word);
    if (/[.!?…]$/.test(word.word)) flush();
  }
  flush();
  return cues;
}

export function splitLongCue(cue: Cue): Cue[] {
  const duration = cue.end - cue.start;
  if (duration <= MAX_CUE_SEC) return [cue];
  const sentences = cue.text.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim());
  if (!sentences || sentences.length < 2) return [cue];

  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  let start = cue.start;
  return sentences.filter(Boolean).map((text) => {
    const end = start + (duration * text.length) / total;
    const split = { start, end, text };
    start = end;
    return split;
  });
}

export function languageCode(language: string): string {
  const lower = language.trim().toLowerCase();
  return LANGUAGE_CODES[lower] ?? lower.split(/[-_]/)[0] ?? lower;
}

export function translationTarget(language: string): string {
  return language === 'vi' ? 'en' : 'vi';
}

export function languageName(
  language: string,
  displayLanguage = language,
): string {
  try {
    const name = new Intl.DisplayNames([displayLanguage], {
      type: 'language',
    }).of(language);
    if (name && name !== language) {
      return name.charAt(0).toLocaleUpperCase(displayLanguage) + name.slice(1);
    }
  } catch {}
  return language;
}
