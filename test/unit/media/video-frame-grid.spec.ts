import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import {
  composeFrameGrid,
  frameGridLayouts,
} from '../../../src/media/video-frame-grid.js';

const binary = typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg';

function sampleFrame(size: string): Buffer {
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
      'mjpeg',
      'pipe:1',
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return result.stdout;
}

function dimensionsOf(jpeg: Buffer): { width: number; height: number } {
  const probe = spawnSync(binary, ['-hide_banner', '-i', 'pipe:0'], {
    input: jpeg,
  });
  const match = /, (\d+)x(\d+)/.exec(probe.stderr.toString());
  return { width: Number(match?.[1]), height: Number(match?.[2]) };
}

describe('frameGridLayouts', () => {
  it('fills 3x3 grids in order and shrinks the last one', () => {
    expect(frameGridLayouts(24, 3)).toEqual([
      { start: 0, count: 9, columns: 3, rows: 3 },
      { start: 9, count: 9, columns: 3, rows: 3 },
      { start: 18, count: 6, columns: 3, rows: 2 },
    ]);
  });

  it('gives a short video a 2x2 instead of a mostly empty 3x3', () => {
    expect(frameGridLayouts(4, 3)).toEqual([
      { start: 0, count: 4, columns: 2, rows: 2 },
    ]);
  });

  it('keeps one frame per grid at size 1', () => {
    expect(frameGridLayouts(2, 1)).toEqual([
      { start: 0, count: 1, columns: 1, rows: 1 },
      { start: 1, count: 1, columns: 1, rows: 1 },
    ]);
  });

  it('has no grid without frames', () => {
    expect(frameGridLayouts(0, 3)).toEqual([]);
  });
});

describe('composeFrameGrid', () => {
  it.each([
    ['1024x576', 9, 3, 3],
    ['1024x576', 5, 3, 2],
    ['576x1024', 9, 3, 3],
    ['576x1024', 4, 2, 2],
  ])(
    'tiles %s frames (%i in %ix%i) within the model image limits',
    async (size, count, columns, rows) => {
      const frames = Array.from({ length: count }, () => sampleFrame(size));

      const { width, height } = dimensionsOf(
        await composeFrameGrid(frames, { columns, rows }),
      );

      expect(Math.min(width, height)).toBeGreaterThanOrEqual(256);
      expect(Math.max(width, height)).toBeLessThanOrEqual(1280);
      expect(width * height).toBeGreaterThanOrEqual(78_400);
      expect(width * height).toBeLessThanOrEqual(2_458_624);
    },
  );

  it('keeps the frame aspect ratio in the layout', async () => {
    const frames = Array.from({ length: 9 }, () => sampleFrame('1024x576'));

    const { width, height } = dimensionsOf(
      await composeFrameGrid(frames, { columns: 3, rows: 3 }),
    );

    expect(width / height).toBeCloseTo(16 / 9, 1);
  });

  it('rejects more frames than cells', async () => {
    const frames = Array.from({ length: 5 }, () => sampleFrame('64x64'));

    await expect(
      composeFrameGrid(frames, { columns: 2, rows: 2 }),
    ).rejects.toThrow('do not fit');
  });
});
