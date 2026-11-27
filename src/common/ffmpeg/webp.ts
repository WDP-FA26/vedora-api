import { runFfmpeg } from './ffmpeg.js';

const WEBP_QUALITY = 80;

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
