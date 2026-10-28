import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

export const DASHBOARD_TIME_ZONE = 'Asia/Bangkok';
export const DAY_MS = 86_400_000;
export const MAX_DASHBOARD_DAYS = 90;

export interface DashboardRange {
  from: string;
  to: string;
  dayCount: number;
  timeZone: typeof DASHBOARD_TIME_ZONE;
  start: Date;
  endExclusive: Date;
}

function invalidRange(): never {
  throw new InvalidInputException(
    'INVALID_DASHBOARD_RANGE',
    'Provide both from/to as valid YYYY-MM-DD dates, in ascending order, spanning at most 90 inclusive days',
  );
}

function dayEpoch(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) === 0)
    invalidRange();
  const epoch = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== value
  )
    invalidRange();
  return epoch;
}

export function resolveDashboardRange(
  query: { from?: string; to?: string },
  now = new Date(),
): DashboardRange {
  if ((query.from === undefined) !== (query.to === undefined)) invalidRange();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const to = query.to ?? today;
  const last = dayEpoch(to);
  const from =
    query.from ?? new Date(last - 29 * DAY_MS).toISOString().slice(0, 10);
  const first = dayEpoch(from);
  const dayCount = (last - first) / DAY_MS + 1;
  if (dayCount < 1 || dayCount > MAX_DASHBOARD_DAYS) invalidRange();
  // Bangkok is UTC+07:00 with no DST. Boundaries are explicit, independent
  // of the Node process or database connection's local timezone.
  return {
    from,
    to,
    dayCount,
    timeZone: DASHBOARD_TIME_ZONE,
    start: new Date(`${from}T00:00:00+07:00`),
    endExclusive: new Date(Date.parse(`${to}T00:00:00+07:00`) + DAY_MS),
  };
}
