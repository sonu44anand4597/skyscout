import assert from "node:assert/strict";
import test from "node:test";
import { dispatchNotification } from "./notificationProviders.js";

test("notification dispatch sends the same event through configured providers", async () => {
  const event = { type: "PRICE_DROP", dedupeKey: "track-1:drop-1" };
  const received = [];
  await dispatchNotification(event, [
    { send: async (notification) => received.push(notification) },
    { send: async (notification) => received.push(notification) },
  ]);
  assert.deepEqual(received, [event, event]);
});

test("notification dispatch rejects providers without a send method", async () => {
  await assert.rejects(dispatchNotification({}, [{}]), /implement send\(\)/);
});

test("optional provider failure does not suppress later delivery", async () => {
  const received = [];
  const failures = [];
  await dispatchNotification({ type: "TARGET_REACHED" }, [
    { provider: { send: async () => { throw new Error("mail unavailable"); } }, required: false },
    { provider: { send: async (event) => received.push(event) }, required: true },
  ], (error) => failures.push(error.message));
  assert.deepEqual(failures, ["mail unavailable"]);
  assert.equal(received.length, 1);
});

test("required provider failure rejects delivery", async () => {
  await assert.rejects(dispatchNotification({}, [
    { provider: { send: async () => { throw new Error("database unavailable"); } }, required: true },
  ]), /database unavailable/);
});
