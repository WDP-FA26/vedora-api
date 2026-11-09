import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import {
  FfmpegError,
  runFfmpeg as runFfmpegProcess,
} from '../../common/ffmpeg/ffmpeg.js';
import { ExternalServiceException } from '../../common/exceptions/external-service.exception.js';

export interface Interval {
  start: number;
  end: number;
}

const SILENCE_NOISE = '-35dB';
const MIN_SILENCE_SEC = 0.6;
const PADDING_SEC = 0.2;
const MIN_SPEECH_SEC = 0.3;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const NO_AUDIO = /does not contain any stream|matches no streams/;

function runFfmpeg(args: string[], input?: Buffer) {
  return runFfmpegProcess(args, input, FFMPEG_TIMEOUT_MS);
}

export function parseSilences(log: string, duration: number): Interval[] {
  const silences: Interval[] = [];
  let start: number | null = null;
  for (const match of log.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?)/g)) {
    const time = Number(match[2]);
    if (match[1] === 'start') {
      start = Math.max(0, time);
    } else if (start !== null) {
      silences.push({ start, end: time });
      start = null;
    }
  }
  if (start !== null) silences.push({ start, end: duration });
  return silences;
}

export function speechIntervals(
  silences: Interval[],
  duration: number,
): Interval[] {
  const speech: Interval[] = [];
  let cursor = 0;
  for (const silence of [...silences, { start: duration, end: duration }]) {
    if (silence.start - cursor >= MIN_SPEECH_SEC) {
      const start = Math.max(0, cursor - PADDING_SEC);
      const end = Math.min(duration, silence.start + PADDING_SEC);
      const last = speech.at(-1);
      if (last && start <= last.end) last.end = end;
      else speech.push({ start, end });
    }
    cursor = Math.max(cursor, silence.end);
  }
  return speech;
}

export function toOriginalTime(speech: Interval[], time: number): number {
  let offset = 0;
  for (const interval of speech) {
    const length = interval.end - interval.start;
    if (time <= offset + length) return interval.start + (time - offset);
    offset += length;
  }
  return speech.at(-1)?.end ?? time;
}

export interface SpeechAudio {
  audio: Buffer;
  speech: Interval[];
}

export async function extractSpeechAudio(
  sourceUrl: string,
  duration: number,
): Promise<SpeechAudio | null> {
  const dir = await mkdtemp(join(tmpdir(), 'vedora-captions-'));
  try {
    const video = join(dir, 'source');
    await download(sourceUrl, video);
    return await cutSilence(video, duration);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new ExternalServiceException(
      'cloudinary',
      `Downloading the video answered ${response.status}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    createWriteStream(path),
  );
}

async function cutSilence(
  video: string,
  duration: number,
): Promise<SpeechAudio | null> {
  let decoded: { stdout: Buffer; stderr: string };
  try {
    decoded = await runFfmpeg([
      '-i',
      video,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      `silencedetect=noise=${SILENCE_NOISE}:duration=${MIN_SILENCE_SEC}`,
      '-f',
      'wav',
      'pipe:1',
    ]);
  } catch (error) {
    if (error instanceof FfmpegError && NO_AUDIO.test(error.stderr))
      return null;
    throw error;
  }
  const speech = speechIntervals(
    parseSilences(decoded.stderr, duration),
    duration,
  );
  if (speech.length === 0) return null;

  const select = speech
    .map(({ start, end }) => `between(t,${start.toFixed(3)},${end.toFixed(3)})`)
    .join('+');
  const { stdout: audio } = await runFfmpeg(
    [
      '-i',
      'pipe:0',
      '-af',
      `aselect='${select}',asetpts=N/SR/TB`,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '48k',
      '-f',
      'mp3',
      'pipe:1',
    ],
    decoded.stdout,
  );
  return { audio, speech };
}
