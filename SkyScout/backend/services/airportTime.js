export function airportDate(now, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Resolve airport wall time without using the host's timezone. Reject ambiguous
// and nonexistent DST times rather than guessing which instant was intended.
export function scheduleInstant(value, timezone) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, y, m, d, h, minute, second = '0', zone] = match;
  const target = Date.UTC(+y, +m - 1, +d, +h, +minute, +second);
  const check = new Date(target);
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +m - 1 || check.getUTCDate() !== +d || check.getUTCHours() !== +h || check.getUTCMinutes() !== +minute || check.getUTCSeconds() !== +second) return null;
  if (zone) { const parsed = Date.parse(value.replace(' ', 'T')); return Number.isFinite(parsed) ? new Date(parsed) : null; }
  if (!timezone) return null;
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return null; }
  const wall = (milliseconds) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(milliseconds)).map(({ type, value: part }) => [type, part]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  };
  const candidates = new Set();
  for (const shift of [-36, 0, 36]) {
    const probe = target + shift * 3600000;
    const candidate = target - (wall(probe) - probe);
    if (wall(candidate) === target) candidates.add(candidate);
  }
  return candidates.size === 1 ? new Date([...candidates][0]) : null;
}
