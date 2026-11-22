const INTERNAL_ORIGIN = 'https://skyscout.invalid';

export function internalReturnPath(value, fallback = '/dashboard') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fallback;
  try {
    const target = new URL(value, INTERNAL_ORIGIN);
    return target.origin === INTERNAL_ORIGIN ? `${target.pathname}${target.search}${target.hash}` : fallback;
  } catch { return fallback; }
}

export function dashboardPath(flightId) {
  return /^[a-f\d]{24}$/i.test(flightId || '') ? `/dashboard?flight=${flightId}` : '/dashboard';
}

export function readDashboardSelection(userId, storage) {
  try { const value = (storage || globalThis.sessionStorage)?.getItem(`skyscout:dashboard:${userId}:selected`); return /^[a-f\d]{24}$/i.test(value || '') ? value : ''; }
  catch { return ''; }
}

export function saveDashboardSelection(userId, flightId, storage) {
  try { if (userId && /^[a-f\d]{24}$/i.test(flightId || '')) (storage || globalThis.sessionStorage)?.setItem(`skyscout:dashboard:${userId}:selected`, flightId); }
  catch { /* Storage-disabled browsers can still navigate and use query context. */ }
}
