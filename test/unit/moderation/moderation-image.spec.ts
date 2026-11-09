import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { toJevJpeg } from '../../../src/moderation/moderation-image.js';

function sampleImage(size: string, format: string): Buffer {
  const binary = typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg';
  const result = spawnSync(
    binary,
    [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=green:s=${size}`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      format,
      'pipe:1',
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return result.stdout;
}

function dimensionsOf(jpeg: Buffer): { width: number; height: number } {
  const binary = typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg';
  const probe = spawnSync(binary, ['-hide_banner', '-i', 'pipe:0'], {
    input: jpeg,
  });
  const match = /, (\d+)x(\d+)/.exec(probe.stderr.toString());
  return { width: Number(match?.[1]), height: Number(match?.[2]) };
}

describe('toJevJpeg', () => {
  it.each([
    ['2400x1600', 'png'],
    ['1281x853', 'mjpeg'],
    ['100x100', 'png'],
    ['100x1000', 'mjpeg'],
  ])('fits Jev limits for a %s %s', async (size, format) => {
    const { width, height } = dimensionsOf(
      await toJevJpeg(sampleImage(size, format)),
    );
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(256);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1568);
    expect(width * height).toBeGreaterThanOrEqual(78_400);
    expect(width * height).toBeLessThanOrEqual(2_458_624);
  });
});
