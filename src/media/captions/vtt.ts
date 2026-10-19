/** One caption line, timed against the original video in seconds. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

function timestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms % 1000, 3)}`;
}

/** A WebVTT file for `cues`; `-->` in the text can't end a cue early. */
export function toVtt(cues: Cue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.replace(/-->/g, '→')}`,
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}
