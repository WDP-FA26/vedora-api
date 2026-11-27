export function zonedMidnight(day: string, timeZone: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  let epoch = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(epoch).map((part) => [part.type, part.value]),
    );
    const observed = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    const difference = target - observed;
    if (difference === 0) return new Date(epoch);
    epoch += difference;
  }
  throw new Error(
    `Calendar midnight does not exist in timezone ${timeZone}: ${day}`,
  );
}

export function nextCalendarDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function calendarDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
