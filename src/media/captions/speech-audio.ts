import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import ffmpegStatic from 'ffmpeg-static';

/** A stretch of the original video, in seconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Quieter than this counts as silence. */
const SILENCE_NOISE = '-35dB';
/** Pauses shorter than this stay in, so words and breaths aren't clipped. */
const MIN_SILENCE_SEC = 0.6;
/** Speech kept on each side of a pause, so word edges survive the cut. */
const PADDING_SEC = 0.2;
/** Speech shorter than this is a click or a cough, not words. */
const MIN_SPEECH_SEC = 0.3;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** `FFMPEG_PATH` (the Docker image's ffmpeg), else the npm-bundled binary. */
function ffmpegPath(): string {
  // ffmpeg-static types its CommonJS export as an ES default, which
  // `nodenext` resolves to the module namespace instead of the path.
  const bundled = typeof ffmpegStatic === 'string' ? ffmpegStatic : null;
  return process.env.FFMPEG_PATH || bundled || 'ffmpeg';
}

/** Thrown when the video has no audio stream at all. */
class NoAudioError extends Error {}

/** Runs ffmpeg, piping `input` to its stdin when given. */
function runFfmpeg(
  args: string[],
  input?: Buffer,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', ...args], {
      stdio: 'pipe',
      timeout: FFMPEG_TIMEOUT_MS,
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } else if (
        /does not contain any stream|matches no streams/.test(stderr)
      ) {
        reject(new NoAudioError());
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join(' ');
        reject(new Error(`ffmpeg exited with ${signal ?? code}: ${tail}`));
      }
    });
    // ffmpeg exiting early closes stdin; `close` reports the failure.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Silences from ffmpeg's `silencedetect` log. */
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
  // Silence running to the end of the file has no `silence_end`.
  if (start !== null) silences.push({ start, end: duration });
  return silences;
}

/** The stretches between silences, padded and with blips dropped. */
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

/**
 * Maps a time in the speech-only audio back to the original video. The cut
 * audio is the `speech` intervals played back to back.
 */
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
  /** Mono 16 kHz MP3 holding only the speech, ready for Whisper. */
  audio: Buffer;
  /** Where each piece of `audio` sits in the original video. */
  speech: Interval[];
}

/**
 * Extracts the audio of `sourceUrl` and cuts out the silence. Returns `null`
 * when the video has no sound above the silence threshold, so silent clips
 * never reach Whisper (which invents text for silence).
 */
export async function extractSpeechAudio(
  sourceUrl: string,
  duration: number,
): Promise<SpeechAudio | null> {
  // The static ffmpeg build can't resolve hostnames, and MP4s with the index
  // at the end can't be read from a pipe, so the video goes to a temp file.
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
    throw new Error(`Downloading the video answered ${response.status}`);
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
  // Decode the audio to WAV on stdout and log the silences in one pass.
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
    if (error instanceof NoAudioError) return null;
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
