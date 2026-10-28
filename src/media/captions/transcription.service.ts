import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chatModel, DEFAULT_CHAT_MODEL } from '../../ai/openrouter';
import type { ReasoningEffort } from '../../ai/reasoning';
import { generateText, type LanguageModel, Output } from 'ai';
import { z } from 'zod';
import { parsePayload, validatePayload } from '../../common/validation';
import { type SpeechAudio, toOriginalTime } from './speech-audio';
import {
  OpenRouterErrorBody,
  TranscriptionResponse,
} from './transcription.dto';
import type { Cue } from './vtt';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const TRANSCRIBE_TIMEOUT_MS = 3 * 60_000;
const TRANSLATE_TIMEOUT_MS = 2 * 60_000;

/** Biases transcription toward these spellings. */
const CAPTION_PROMPT =
  'Vedora, tàu hủ, đậu hũ, chao, nấm mèo, bún tàu, hạt nêm, dầu điều, nước tương, mắm chay, tempeh, seitan.';
const NEVER_TRANSLATE = ['Vedora'];

/** Whisper's own guess that a segment is not speech. */
const MAX_NO_SPEECH_PROB = 0.6;
/** Below this, Whisper was guessing at words. */
const MIN_AVG_LOGPROB = -1;
/**
 * Lines Whisper is known to invent for music or noise, learned from
 * subtitled YouTube videos. Silence is cut before transcription, so these
 * only slip through over background sound.
 */
const HALLUCINATIONS = [
  /ghiền mì gõ/i,
  /đăng ký kênh/i,
  /subscribe cho kênh/i,
  /thanks for watching/i,
];
/** Longer cues are split at sentence breaks so they fit on screen. */
const MAX_CUE_SEC = 7;

/** Whisper names some languages in full instead of by code. */
const LANGUAGE_CODES: Record<string, string> = {
  vietnamese: 'vi',
  english: 'en',
};

// zod stays for the AI SDK's structured output; the HTTP bodies above are
// class-validator DTOs.
const translationOutput = z.object({ lines: z.array(z.string()) });

export interface Transcript {
  /** e.g. `vi`. */
  language: string;
  /** Timed against the original video; empty when nothing was said. */
  cues: Cue[];
}

/**
 * Turns speech into timed captions with Whisper on OpenRouter, and
 * translates them with the chat model.
 */
@Injectable()
export class TranscriptionService {
  private readonly apiKey: string;
  private readonly transcriptionModel: string;
  private readonly translationModel: LanguageModel;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.transcriptionModel = configService.get<string>(
      'TRANSCRIPTION_MODEL',
      'openai/whisper-large-v3',
    );
    this.translationModel = chatModel({
      apiKey: this.apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODEL',
        DEFAULT_CHAT_MODEL,
      ),
      reasoningEffort: configService.get<ReasoningEffort>(
        'OPENROUTER_REASONING_EFFORT',
        'low',
      ),
    });
  }

  async transcribe({ audio, speech }: SpeechAudio): Promise<Transcript> {
    const response = await fetch(`${OPENROUTER_API}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.transcriptionModel,
        input_audio: { data: audio.toString('base64'), format: 'mp3' },
        response_format: 'verbose_json',
        prompt: CAPTION_PROMPT,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = validatePayload(OpenRouterErrorBody, body).value?.error
        ?.message;
      throw new Error(
        `Transcription answered ${response.status}${message ? `: ${message}` : ''}`,
      );
    }
    const result = parsePayload(TranscriptionResponse, body);
    const audioEnd = speech.reduce(
      (sum, { start, end }) => sum + end - start,
      0,
    );
    // Not every provider returns segments; then the text spans all speech.
    const segments = result.segments ?? [
      { start: 0, end: audioEnd, text: result.text },
    ];

    const cues = segments
      .filter(
        (segment) =>
          (segment.no_speech_prob ?? 0) <= MAX_NO_SPEECH_PROB &&
          (segment.avg_logprob ?? 0) >= MIN_AVG_LOGPROB &&
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

  /** The same cues in `to`, one line per cue; throws if lines go missing. */
  async translate(cues: Cue[], from: string, to: string): Promise<Cue[]> {
    const { output } = await generateText({
      model: this.translationModel,
      instructions: `You translate video captions about plant-based cooking from ${languageName(from, 'en')} to ${languageName(to, 'en')}. Return exactly one translated line per input line, in the same order, as {"lines": [...]}. Keep these words unchanged: ${NEVER_TRANSLATE.join(', ')}. Never merge, split or skip lines.`,
      prompt: JSON.stringify(cues.map((cue) => cue.text)),
      output: Output.object({ schema: translationOutput }),
      abortSignal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (output.lines.length !== cues.length) {
      throw new Error(
        `Translation returned ${output.lines.length} lines for ${cues.length} cues`,
      );
    }
    return cues.map((cue, index) => ({
      ...cue,
      text: output.lines[index].trim(),
    }));
  }
}

/** Splits a cue longer than `MAX_CUE_SEC` at sentence breaks, by length. */
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

/** Vietnamese videos get English captions; everything else gets Vietnamese. */
export function translationTarget(language: string): string {
  return language === 'vi' ? 'en' : 'vi';
}

/** The name of `language` in `displayLanguage`, e.g. "Tiếng Việt" in `vi`. */
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
  } catch {
    // Not a valid language tag.
  }
  return language;
}
