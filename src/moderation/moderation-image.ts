import { runFfmpeg } from '../common/ffmpeg/ffmpeg.js';

const MAX_SIDE_PX = 1280;
const MIN_SIDE_PX = 288;

export async function toJevJpeg(source: Buffer): Promise<Buffer> {
  const filter = [
    `scale=w='min(iw,${MAX_SIDE_PX})':h='min(ih,${MAX_SIDE_PX})':force_original_aspect_ratio=decrease`,
    "crop=w='trunc(iw/2)*2':h='trunc(ih/2)*2'",
    `pad=w='max(iw,${MIN_SIDE_PX})':h='max(ih,${MIN_SIDE_PX})':x='(ow-iw)/2':y='(oh-ih)/2':color=white`,
    'format=yuvj420p',
  ].join(',');
  const { stdout } = await runFfmpeg(
    [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-vf',
      filter,
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    source,
  );
  return stdout;
}
