import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

const DEFAULT_TIMEOUT_MS = 30_000;

function ffmpegPath(): string {
  const bundled = typeof ffmpegStatic === 'string' ? ffmpegStatic : null;
  return process.env.FFMPEG_PATH || bundled || 'ffmpeg';
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function runFfmpeg(
  args: string[],
  input?: Buffer,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', ...args], {
      stdio: 'pipe',
      timeout: timeoutMs,
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-3).join(' ');
      reject(
        new FfmpegError(
          `ffmpeg exited with ${signal ?? code}: ${tail}`,
          stderr,
        ),
      );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
