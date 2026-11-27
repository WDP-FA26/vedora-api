export interface FrameSampling {
  intervalSeconds: number;
  minPerVideo: number;
  maxPerPost: number;
}

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
