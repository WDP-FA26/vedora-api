import { runFfmpeg } from './ffmpeg.js';

/** libwebp quality (0-100); 80 keeps photos visually lossless at a fraction of PNG size. */
const WEBP_QUALITY = 80;

/** Re-encodes one still image (PNG, JPEG, WebP) as lossy WebP, keeping its size and alpha. */
export async function toWebp(source: Uint8Array): Promise<Buffer> {
  const input = Buffer.from(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const { stdout } = await runFfmpeg(
    [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      String(WEBP_QUALITY),
      '-f',
      'webp',
      'pipe:1',
    ],
    input,
  );
  return stdout;
}
