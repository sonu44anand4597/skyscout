// Short-lived, user-scoped in-memory navigation snapshots, never persistent fares.
export function createResultsCache({ ttlMs = 5 * 60000, limit = 8, now = Date.now } = {}) {
  const entries = new Map();
  return {
    read(key) {
      const saved = entries.get(key);
      if (!saved || saved.expiresAt <= now()) { entries.delete(key); return null; }
      return saved.view;
    },
    write(key, view) {
      const prior = entries.get(key);
      const expiresAt = prior && prior.view.searchedAt === view.searchedAt ? prior.expiresAt : now() + ttlMs;
      entries.delete(key);
      while (entries.size >= limit) entries.delete(entries.keys().next().value);
      entries.set(key, { view, expiresAt });
    },
    untrack(flightId) {
      for (const saved of entries.values()) {
        saved.view = { ...saved.view,
          trackedFlightIds: Object.fromEntries(Object.entries(saved.view.trackedFlightIds || {}).filter(([, id]) => id !== flightId)),
          lastTrackedFlightId: saved.view.lastTrackedFlightId === flightId ? null : saved.view.lastTrackedFlightId };
      }
    },
    clear() { entries.clear(); },
  };
}

export const resultsCache = createResultsCache();
export const resultsViewKey = (userId, historyKey, search) => JSON.stringify([userId || 'guest', historyKey, search]);
