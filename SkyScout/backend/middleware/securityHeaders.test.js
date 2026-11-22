import assert from "node:assert/strict";
import test from "node:test";
import securityHeaders from "./securityHeaders.js";

function apply(path) {
  const headers = new Map();
  let continued = false;
  securityHeaders({ path }, { setHeader: (name, value) => headers.set(name, value) }, () => { continued = true; });
  return { headers, continued };
}

test("security middleware applies browser hardening headers", () => {
  const { headers, continued } = apply("/health");
  assert.equal(continued, true);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
});

test("user-owned and authentication responses cannot be cached", () => {
  assert.equal(apply("/api/auth/me").headers.get("Cache-Control"), "no-store");
  assert.equal(apply("/api/tracked-flights").headers.get("Cache-Control"), "no-store");
  assert.equal(apply("/api/flights/search").headers.has("Cache-Control"), false);
});
