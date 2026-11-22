import assert from "node:assert/strict";
import test from "node:test";
import { commitMonitoredQuote, matchesTrackedFlight, monitoringRetryDelay, processFlight, quoteNotifications } from "./monitoringWorker.js";

const tracked = {
  origin: "JFK",
  destination: "LAX",
  departureDate: "2099-11-20",
  departureAt: "2099-11-20T09:00:00-05:00",
  airline: "Example Air",
  flightNumber: "EX 100",
};

test("flight matching requires route, date, flight number and airline when identifiers exist", () => {
  const candidate = { from: "JFK", to: "LAX", departureAt: "2099-11-20T09:00:00-05:00", airline: "Example Air", flightNumber: "EX 100" };
  assert.equal(matchesTrackedFlight(candidate, tracked), true);
  assert.equal(matchesTrackedFlight({ ...candidate, flightNumber: "EX 101" }, tracked), false);
  assert.equal(matchesTrackedFlight({ ...candidate, airline: "Other Air" }, tracked), false);
  assert.equal(matchesTrackedFlight({ ...candidate, to: "SFO" }, tracked), false);
  assert.equal(matchesTrackedFlight({ ...candidate, departureAt: "2099-11-21T09:00:00-05:00" }, tracked), false);
});

test("fallback matching accepts only the same airline within ninety minutes", () => {
  const noFlightNumber = { ...tracked, flightNumber: null };
  const candidate = { from: "JFK", to: "LAX", departureAt: "2099-11-20T10:29:00-05:00", airline: "Example Air" };
  assert.equal(matchesTrackedFlight(candidate, noFlightNumber), true);
  assert.equal(matchesTrackedFlight({ ...candidate, departureAt: "2099-11-20T10:31:00-05:00" }, noFlightNumber), false);
  assert.equal(matchesTrackedFlight({ ...candidate, airline: "Other Air" }, noFlightNumber), false);
});

test("multi-city matching evaluates the candidate's latest journey leg", () => {
  const candidate = { journeyLegs: [{ from: "JFK", to: "ORD" }, { from: "ORD", to: "LAX", date: "2099-11-21", departureAt: "2099-11-21T08:00:00-06:00", airline: "Example Air", flightNumber: "EX 200" }] };
  assert.equal(matchesTrackedFlight(candidate, tracked, { from: "ORD", to: "LAX", date: "2099-11-21", airline: "Example Air", flightNumber: "EX 200" }), true);
});

test("monitoring retries back off exponentially and cap at twenty-four hours", () => {
  assert.equal(monitoringRetryDelay(0), 60 * 60 * 1000);
  assert.equal(monitoringRetryDelay(3), 8 * 60 * 60 * 1000);
  assert.equal(monitoringRetryDelay(20), 24 * 60 * 60 * 1000);
});

function workerDependencies(overrides = {}) {
  return {
    commitQuote: null,
    searchFlights: async () => ({ flights: [] }),
    getReturnFlights: async () => [],
    clearLease: async () => {},
    recordObservation: async () => {},
    createNotification: async () => {},
    checkTargetNotification: async () => {},
    getDelayPrediction: async () => {},
    logError: () => {},
    ...overrides,
  };
}

test("an unresolved monitoring check preserves price and emits a review event", async () => {
  const released = [];
  const notifications = [];
  await processFlight({ ...tracked, _id: "flight-1", userId: "user-1", currentPrice: 500, currency: "USD", tripType: "one-way" }, workerDependencies({
    clearLease: async (_id, updates) => released.push(updates),
    createNotification: async (notification) => notifications.push(notification),
  }));
  assert.equal(released.length, 1);
  assert.equal(released[0].lastCheckError, "No sufficiently confident flight match was found.");
  assert.equal(Object.hasOwn(released[0], "currentPrice"), false);
  assert.equal(notifications[0].type, "CHECK_UNRESOLVED");
});

test("a departed flight is completed without calling the provider", async () => {
  const released = [];
  let searches = 0;
  await processFlight({ ...tracked, _id: "flight-1", departureDate: "2020-01-01" }, workerDependencies({
    searchFlights: async () => { searches += 1; return { flights: [] }; },
    clearLease: async (_id, updates) => released.push(updates),
  }));
  assert.equal(searches, 0);
  assert.equal(released[0].status, "completed");
  assert.equal(released[0].nextCheckAt, null);
});

test("a matched lower fare records history, updates price, evaluates target and refreshes prediction", async () => {
  const candidate = { from: "JFK", to: "LAX", departureAt: tracked.departureAt, airline: tracked.airline, flightNumber: tracked.flightNumber, price: 420 };
  const observations = [];
  const released = [];
  const notifications = [];
  const targets = [];
  const predictions = [];
  const flight = { ...tracked, _id: "flight-1", userId: "user-1", currentPrice: 500, currency: "USD", tripType: "one-way", checkFailures: 2 };
  await processFlight(flight, workerDependencies({
    searchFlights: async () => ({ searchedAt: new Date().toISOString(), flights: [candidate] }),
    recordObservation: async (observation) => observations.push(observation),
    clearLease: async (_id, updates) => released.push(updates),
    createNotification: async (notification) => notifications.push(notification),
    checkTargetNotification: async (_flight, price) => targets.push(price),
    getDelayPrediction: async (value) => predictions.push(value._id),
  }));
  assert.equal(observations[0].price, 420);
  assert.equal(released[0].currentPrice, 420);
  assert.equal(released[0].checkFailures, 0);
  assert.equal(notifications[0].type, "PRICE_DROP");
  assert.deepEqual(targets, [420]);
  assert.deepEqual(predictions, ["flight-1"]);
});

test("a provider failure releases the lease with exponential retry state", async () => {
  const released = [];
  await processFlight({ ...tracked, _id: "flight-1", currentPrice: 500, currency: "USD", checkFailures: 3 }, workerDependencies({
    searchFlights: async () => { throw new Error("provider unavailable"); },
    clearLease: async (_id, updates) => released.push(updates),
  }));
  assert.equal(released[0].checkFailures, 4);
  assert.equal(released[0].lastCheckError, "Price check failed (provider_or_storage_error); retry scheduled.");
  const delay = released[0].nextCheckAt.getTime() - Date.now();
  assert.ok(delay > 7.9 * 60 * 60 * 1000 && delay <= 8 * 60 * 60 * 1000);
});

test('an upcoming departure today retains the six-hour monitoring cadence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-14T10:00:00Z') });
  const today = { ...tracked, _id: 'same-day-flight', userId: 'owner', departureDate: '2026-11-14', departureAt: '2026-11-14T09:00:00-05:00', currentPrice: 500, currency: 'USD' };
  const updates = [];
  await processFlight(today, workerDependencies({
    searchFlights: async () => ({ searchedAt: new Date().toISOString(), flights: [{ from: 'JFK', to: 'LAX', departureAt: today.departureAt, airline: today.airline, flightNumber: today.flightNumber, price: 450, currency: 'USD' }] }),
    clearLease: async (_id, value) => updates.push(value),
  }));
  assert.equal(updates[0].nextCheckAt.toISOString(), '2026-11-14T16:00:00.000Z');
});

test('stale provider fares never create observations or price notifications', async () => {
  const releases = [];
  await processFlight({ ...tracked, _id: 'stale-flight', userId: 'owner', currentPrice: 500, currency: 'USD' }, workerDependencies({
    searchFlights: async (input) => {
      assert.equal(input.fresh, true);
      return { searchedAt: new Date(Date.now() - 3600000).toISOString(), flights: [{ from: tracked.origin, to: tracked.destination, departureAt: tracked.departureAt, airline: tracked.airline, flightNumber: tracked.flightNumber, price: 300, currency: 'USD' }] };
    },
    clearLease: async (_id, update) => releases.push(update),
    recordObservation: async () => assert.fail('stale quotes must not become new observations'),
    createNotification: async () => assert.fail('stale quotes must not trigger alerts'),
  }));
  assert.match(releases[0].lastCheckError, /stale quote/);
  assert.equal(releases[0].currentPrice, undefined);
});

test('missing or malformed quote timestamps preserve the verified fare instead of inventing check-time observations', async () => {
  for (const timestamp of [undefined, 'not a timestamp']) {
    const releases = [];
    await processFlight({ ...tracked, _id: 'undated-flight', userId: 'owner', currentPrice: 500, currency: 'USD' }, workerDependencies({
      searchFlights: async () => ({ searchedAt: timestamp, flights: [{ from: tracked.origin, to: tracked.destination, departureAt: tracked.departureAt, airline: tracked.airline, flightNumber: tracked.flightNumber, price: 300, currency: 'USD' }] }),
      clearLease: async (_id, update) => releases.push(update),
      recordObservation: async () => assert.fail('an unverifiable quote must not become a fresh observation'),
      createNotification: async () => assert.fail('an unverifiable quote must not trigger an alert'),
    }));
    assert.match(releases[0].lastCheckError, /verifiable quote timestamp/);
    assert.equal(releases[0].currentPrice, undefined);
  }
});

test('a worker that loses its lease cannot emit an unresolved notification', async () => {
  await processFlight({ ...tracked, _id: 'leased-flight', userId: 'owner', checkLeaseOwner: 'former-owner' }, workerDependencies({
    clearLease: async (_id, _updates, owner) => { assert.equal(owner, 'former-owner'); return { matchedCount: 0 }; },
    createNotification: async () => assert.fail('a paused or reassigned job must not emit a review notification'),
  }));
});

test('a quote cannot be committed without a claimed monitoring lease', async () => {
  assert.equal(await commitMonitoredQuote({ ...tracked, _id: 'unleased-flight' }, {}, {}), false);
});

test('durable price events use the committed previous price, current target and quote identity', () => {
  const observation = { price: 420, quoteKey: 'exact-quote', observedAt: new Date() };
  const events = quoteNotifications({ ...tracked, _id: 'flight', userId: 'owner', currentPrice: 500, targetPrice: 425, currency: 'USD' }, observation);
  assert.deepEqual(events.map((event) => event.type), ['PRICE_DROP', 'TARGET_REACHED']);
  assert.equal(events[0].dedupeKey, 'drop:exact-quote');
  assert.equal(events[0].metadata.previousPrice, 500);
  assert.equal(events[1].metadata.targetPrice, 425);
});
