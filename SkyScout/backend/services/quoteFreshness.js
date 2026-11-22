// A verified observation can remain useful indefinitely when labeled with its
// timestamp. Only quotes within the search cache's five-minute window may
// change a monitored current fare or trigger a price notification.
export const QUOTE_FRESHNESS_MS = 5 * 60 * 1000;
export function quoteIsFresh(observedAt, now = new Date()) {
  const time = new Date(observedAt).getTime();
  const age = new Date(now).getTime() - time;
  return Number.isFinite(time) && age >= -60000 && age <= QUOTE_FRESHNESS_MS;
}
