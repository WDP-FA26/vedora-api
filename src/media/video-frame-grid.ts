import { runtimeConfig } from '../config/runtime-config.js';
import { runFfmpeg } from '../common/ffmpeg/ffmpeg.js';
import { JEV_FILTERS } from '../moderation/moderation-image.js';

const MAX_SIDE_PX = runtimeConfig.MODERATION_IMAGE_MAX_SIDE_PX;
/** White gap between two cells, so the model sees separate frames. */
const CELL_GAP_PX = 4;

export interface GridLayout {
  /** Index of the first frame in this grid. */
  start: number;
  /** Frames in this grid, read left to right, top to bottom. */
  count: number;
  columns: number;
  rows: number;
}

/**
 * Splits `frameCount` frames of one video into grids of at most
 * `cellsPerSide` × `cellsPerSide`, in order. A grid with fewer frames shrinks
 * to the smallest near-square layout that holds them, so 4 frames make a 2×2
 * rather than a 3×3 with five empty cells.
 */
export function frameGridLayouts(
  frameCount: number,
  cellsPerSide: number,
): GridLayout[] {
  const perGrid = cellsPerSide * cellsPerSide;
  const layouts: GridLayout[] = [];
  for (let start = 0; start < frameCount; start += perGrid) {
    const count = Math.min(perGrid, frameCount - start);
    const columns = Math.min(cellsPerSide, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / columns);
    layouts.push({ start, count, columns, rows });
  }
  return layouts;
}

/**
 * Tiles same-sized JPEG frames into one JPEG within the moderation model's
 * image limits. Cells past the last frame stay black.
 */
export async function composeFrameGrid(
  frames: readonly Buffer[],
  layout: Pick<GridLayout, 'columns' | 'rows'>,
): Promise<Buffer> {
  if (frames.length === 0) throw new Error('A frame grid needs a frame');
  if (frames.length > layout.columns * layout.rows) {
    throw new Error(
      `${frames.length} frames do not fit a ${layout.columns}x${layout.rows} grid`,
    );
  }
  const cellWidth = Math.floor(
    (MAX_SIDE_PX - (layout.columns - 1) * CELL_GAP_PX) / layout.columns,
  );
  const cellHeight = Math.floor(
    (MAX_SIDE_PX - (layout.rows - 1) * CELL_GAP_PX) / layout.rows,
  );
  const filters = [
    `scale=w=${cellWidth}:h=${cellHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `tile=${layout.columns}x${layout.rows}:padding=${CELL_GAP_PX}:color=white`,
    ...JEV_FILTERS,
  ];
  const { stdout } = await runFfmpeg(
    [
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      filters.join(','),
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    Buffer.concat(frames),
  );
  return stdout;
}
