export interface FrameSampling {
  /** Target gap between two sampled frames of one video, in seconds. */
  intervalSeconds: number;
  /** Frames every video gets, however short; wins over `maxPerPost`. */
  minPerVideo: number;
  /** Frames a whole post may send to the model, shared by its videos. */
  maxPerPost: number;
}

/**
 * When to grab moderation frames, one list of seconds per video. Each video
 * gets one frame per `intervalSeconds`, at least `minPerVideo`, and the
 * videos share `maxPerPost` so one model call stays bounded. Frames sit in
 * the middle of equal segments, so the first and last moments are skipped.
 * A video of unknown length (0) gets `minPerVideo` frames at 0s.
 */
export function videoFrameTimes(
  durations: readonly number[],
  sampling: FrameSampling,
): number[][] {
  if (durations.length === 0) return [];
  const capPerVideo = Math.max(
    sampling.minPerVideo,
    Math.floor(sampling.maxPerPost / durations.length),
  );

  const times: number[][] = [];
  for (const duration of durations) {
    const wanted = Math.ceil(duration / sampling.intervalSeconds);
    const count = Math.min(capPerVideo, Math.max(sampling.minPerVideo, wanted));
    const seconds: number[] = [];
    for (let index = 0; index < count; index += 1) {
      seconds.push((duration * (index + 0.5)) / count);
    }
    times.push(seconds);
  }
  return times;
}
