export function forecastValidity(forecast, now = Date.now()) {
  const end = Date.parse(forecast?.validTo || '');
  const start = Date.parse(forecast?.validFrom || '');
  if (!Number.isFinite(end)) return 'unknown';
  if (end <= now) return 'expired';
  if (Number.isFinite(start) && start > now) return 'upcoming';
  return Number.isFinite(start) ? 'active' : 'unknown';
}
