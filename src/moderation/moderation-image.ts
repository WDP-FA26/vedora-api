import { runtimeConfig } from '../config/runtime-config.js';
import { runFfmpeg } from '../common/ffmpeg/ffmpeg.js';

const MAX_SIDE_PX = runtimeConfig.MODERATION_IMAGE_MAX_SIDE_PX;
const MIN_SIDE_PX = runtimeConfig.MODERATION_IMAGE_MIN_SIDE_PX;

const MODERATION_FILTERS: readonly string[] = [
  `scale=w='min(iw,${MAX_SIDE_PX})':h='min(ih,${MAX_SIDE_PX})':force_original_aspect_ratio=decrease`,
  "crop=w='trunc(iw/2)*2':h='trunc(ih/2)*2'",
  `pad=w='max(iw,${MIN_SIDE_PX})':h='max(ih,${MIN_SIDE_PX})':x='(ow-iw)/2':y='(oh-ih)/2':color=white`,
  'format=yuvj420p',
];

export async function toModerationJpeg(source: Buffer): Promise<Buffer> {
  const { stdout } = await runFfmpeg(
    [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-vf',
      MODERATION_FILTERS.join(','),
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    source,
  );
  return stdout;
}
