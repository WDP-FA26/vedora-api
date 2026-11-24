import { describe, expect, it } from 'vitest';
import {
  type FrameSampling,
  videoFrameTimes,
} from '@src/media/video-frame-times.js';

const sampling: FrameSampling = {
  intervalSeconds: 5,
  minPerVideo: 4,
  maxPerPost: 24,
};

describe('videoFrameTimes', () => {
  it('gives a short video the minimum, centred in equal segments', () => {
    expect(videoFrameTimes([20], sampling)).toEqual([[2.5, 7.5, 12.5, 17.5]]);
  });

  it('takes one frame per interval for a longer video', () => {
    const [times] = videoFrameTimes([60], sampling);

    expect(times).toHaveLength(12);
    expect(times[0]).toBe(2.5);
    expect(times[11]).toBe(57.5);
  });

  it('spreads frames out when a long video would pass the post cap', () => {
    const [times] = videoFrameTimes([600], sampling);

    expect(times).toHaveLength(24);
    expect(times[1] - times[0]).toBe(25);
  });

  it('shares the post cap between videos', () => {
    const times = videoFrameTimes([600, 600, 10], sampling);

    expect(times.map((list) => list.length)).toEqual([8, 8, 4]);
  });

  it('keeps the minimum per video even when that passes the post cap', () => {
    const times = videoFrameTimes([600, 600, 600, 600], {
      ...sampling,
      maxPerPost: 8,
    });

    expect(times.map((list) => list.length)).toEqual([4, 4, 4, 4]);
  });

  it('samples a video of unknown length at its start', () => {
    expect(videoFrameTimes([0], sampling)).toEqual([[0, 0, 0, 0]]);
  });

  it('returns nothing for a post without videos', () => {
    expect(videoFrameTimes([], sampling)).toEqual([]);
  });
});
