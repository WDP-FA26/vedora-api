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

/** The text of every cue in `vtt`, in order and joined by spaces. */
export function vttText(vtt: string): string {
  return vtt
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const timing = lines.findIndex((line) => line.includes('-->'));
      return timing === -1
        ? ''
        : lines
            .slice(timing + 1)
            .join(' ')
            .trim();
    })
    .filter(Boolean)
    .join(' ');
}
