import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";
import AuthSession from "../models/AuthSession.js";
import TrackedFlight from "../models/TrackedFlight.js";
import PriceObservation from "../models/PriceObservation.js";
import FareIntelligenceAnalysis from "../models/FareIntelligenceAnalysis.js";
import Notification from "../models/Notification.js";
import DisruptionPrediction from "../models/DisruptionPrediction.js";

const base = "http://127.0.0.1:5000/api";
let userId;
let flightId;
let browser;
const profile = path.resolve(`../qa-artifacts/intelligence-chrome-${randomBytes(4).toString("hex")}`);
const browserPort = 9231;
async function browserCheck(cookie) {
  await mkdir(profile, { recursive: true });
  browser = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${browserPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let tab;
  for (let i = 0; i < 100; i += 1) {
    try { tab = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: "PUT" })).json(); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  assert.ok(tab?.webSocketDebuggerUrl, "Chrome CDP did not start");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const network = [];
  const responseIds = [];
  const consoleErrors = [];
  let fixtureResponses = null;
  socket.addEventListener("message", (event) => {
    const item = JSON.parse(event.data);
    if (item.method === "Fetch.requestPaused") {
      const target = item.params.request.url.includes(`/tracked-flights/${flightId}/fare-intelligence`) && !item.params.request.url.includes("/research") ? "fare" : item.params.request.url.includes(`/tracked-flights/${flightId}/destination-intelligence?finalDestination=`) ? "destination" : null;
      const fixture = target && fixtureResponses?.[target];
      const action = fixture ? call("Fetch.fulfillRequest", { requestId: item.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "http://127.0.0.1:5173" }, { name: "Access-Control-Allow-Credentials", value: "true" }], body: Buffer.from(JSON.stringify(fixture)).toString("base64") }) : call("Fetch.continueRequest", { requestId: item.params.requestId });
      action.catch((error) => consoleErrors.push(`Fixture interception: ${error.message}`));
    }
    if (item.method === "Network.responseReceived" && item.params.response.url.includes("/api/")) {
      network.push({ status: item.params.response.status, url: item.params.response.url.replace(String(flightId), ":id") });
      responseIds.push({ id: item.params.requestId, url: item.params.response.url });
    }
    if (item.method === "Runtime.exceptionThrown") consoleErrors.push(item.params.exceptionDetails.text);
    if (!item.id || !pending.has(item.id)) return;
    const call = pending.get(item.id); pending.delete(item.id);
    if (item.error) call.reject(new Error(item.error.message)); else call.resolve(item.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await call("Network.enable"); await call("Runtime.enable"); await call("Page.enable");
  const [name, value] = cookie.split("=");
  await call("Network.setCookie", { name, value, url: "http://127.0.0.1:5000", sameSite: "Lax" });
  await call("Page.navigate", { url: "http://127.0.0.1:5173/dashboard" });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate("Boolean(document.querySelector('section[aria-label=\"Fare Intelligence\"]'))")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate("Boolean(document.querySelector('input[placeholder=\"Koramangala\"]'))")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await evaluate(`document.querySelector('button[aria-label="Refresh destination intelligence"]')?.scrollIntoView()`);
  const inputSet = await evaluate(`(() => { const input = document.querySelector('input[placeholder="Koramangala"]'); if (!input) return "missing"; input.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(input, "Koramangala"); input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Koramangala", inputType: "insertText" })); return input.value; })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const submitReady = await evaluate(`(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === "Check journey"); return { inputSet: ${JSON.stringify(inputSet)}, input: document.querySelector('input[placeholder="Koramangala"]')?.value, enabled: Boolean(button && !button.disabled) }; })()`);
  if (submitReady.enabled) await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === "Check journey")?.click()`);
  for (let i = 0; i < 180; i += 1) {
    const ready = await evaluate("document.body.innerText.includes('Grounded journey developments')");
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const rendered = await evaluate(`(() => { const fare = document.querySelector('section[aria-label="Fare Intelligence"]'); const destination = document.querySelector('section[aria-label="Destination intelligence"]'); return { fareActual: fare?.innerText.includes("₹6,000"), fareCalendar: fare?.innerText.includes("Diwali"), fareGrounded: fare?.innerText.includes("Grounded news and events"), fareSourceLinks: fare?.querySelectorAll('a[href^="https://vertexaisearch.cloud.google.com/"]').length || 0, destinationEntered: destination?.innerText.includes("Koramangala"), destinationRouting: destination?.innerText.includes("GOOGLE_MAPS_API_KEY"), destinationResearch: destination?.innerText.includes("Grounded journey disruption research"), destinationSourceLinks: destination?.querySelectorAll('a[href^="https://vertexaisearch.cloud.google.com/"]').length || 0 }; })()`);
  rendered.fareChart = await evaluate("Boolean(document.querySelector('section[aria-label=\"Fare Intelligence\"] [aria-label*=\"Observed fare chart\"]'))");
  rendered.rawMarkdown = await evaluate("/\\*\\*|^#{2,}/m.test(document.body.innerText)");
  const getPayload = async (match) => {
    const item = responseIds.findLast((entry) => match(entry.url));
    if (!item) return null;
    try { return JSON.parse((await call("Network.getResponseBody", { requestId: item.id })).body); }
    catch { return null; }
  };
  const farePayload = await getPayload((url) => url.endsWith(`/tracked-flights/${flightId}/fare-intelligence`));
  const destinationPayload = await getPayload((url) => url.includes(`/tracked-flights/${flightId}/destination-intelligence?finalDestination=`));
  if (farePayload?.baseline && destinationPayload?.journey) {
    const event = { id: "qa-diwali", title: "QA fixture: Diwali travel context", category: "holiday", summary: "Official national holiday date used to check compact event card rendering.", eventStart: "2026-11-08", eventEnd: null, location: "India", affectedAirports: ["DEL", "BLR"], affectedAirlines: [], affectedRoads: [], impactDirection: "uncertain", impactExplanation: "The date is relevant to this itinerary; a route-specific fare effect has not been established.", relevance: { score: 7, reason: "Names this flight's airports." }, evidenceStatus: "possible", sourceTitle: "NHAI 2026 calendar", sourceUrl: "https://nhai.gov.in/assets/pdf/NHAI_Table_Calendar-2026.pdf", publishedAt: null, researchedAt: new Date().toISOString() };
    fixtureResponses = { fare: { ...farePayload, eventIntelligence: { status: "grounded_result", events: [event], excludedCount: 1, checkedAt: new Date().toISOString(), pressure: "uncertain" } }, destination: { ...destinationPayload, journey: { ...destinationPayload.journey, research: { status: "grounded_result", events: [{ ...event, id: "qa-journey", title: "QA fixture: airport-area advisory", category: "airport", affectedAirports: ["BLR"], affectedRoads: [], routeImpactStatus: "not_verified_as_affected" }], checkedAt: new Date().toISOString(), certainty: "Area-level research only; route impact cannot be verified without a routing provider." } } } };
    await call("Fetch.enable", { patterns: [{ urlPattern: `*tracked-flights/${flightId}/fare-intelligence`, requestStage: "Request" }, { urlPattern: `*tracked-flights/${flightId}/destination-intelligence?finalDestination=*`, requestStage: "Request" }] });
    await call("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 60; i += 1) { if (await evaluate("document.body.innerText.includes('QA fixture: Diwali travel context')")) break; await new Promise((resolve) => setTimeout(resolve, 200)); }
    await evaluate(`(() => { const input = document.querySelector('input[placeholder="Koramangala"]'); input.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Koramangala"); input.dispatchEvent(new InputEvent("input", { bubbles: true })); })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === "Check journey")?.click()`);
    for (let i = 0; i < 60; i += 1) { if (await evaluate("document.body.innerText.includes('QA fixture: airport-area advisory')")) break; await new Promise((resolve) => setTimeout(resolve, 200)); }
    rendered.fixtureCards = await evaluate(`(() => ({ fare: Boolean(document.querySelector('[aria-label="QA fixture: Diwali travel context"]')), destination: Boolean(document.querySelector('[aria-label="QA fixture: airport-area advisory"]')), fareSource: document.querySelector('[aria-label="QA fixture: Diwali travel context"] a')?.href, destinationStatus: document.querySelector('[aria-label="QA fixture: airport-area advisory"]')?.innerText.includes('Route impact unverified'), rawMarkdown: /\\*\\*|^#{2,}/m.test(document.body.innerText) }))()`);
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    rendered.mobile = await evaluate("({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })");
    await evaluate("document.querySelector('button[aria-label=\"Switch to dark mode\"]')?.click()");
    rendered.dark = await evaluate("document.documentElement.classList.contains('dark')");
    await evaluate("document.querySelector('button[aria-label=\"Switch to light mode\"]')?.click()");
    rendered.light = await evaluate("!document.documentElement.classList.contains('dark')");
  }
  socket.close();
  return { submitReady, rendered, network, consoleErrors, farePayload, destinationPayload };
}
try {
  await mongoose.connect(process.env.MONGODB_URI);
  const orphaned = await User.find({ email: /^intelligence-qa-[a-f0-9]{12}@example\.test$/ }).select("_id").lean();
  if (orphaned.length) {
    const ids = orphaned.map((item) => item._id);
    await Promise.all([PriceObservation.deleteMany({ userId: { $in: ids } }), FareIntelligenceAnalysis.deleteMany({ userId: { $in: ids } }), Notification.deleteMany({ userId: { $in: ids } }), DisruptionPrediction.deleteMany({ userId: { $in: ids } }), TrackedFlight.deleteMany({ userId: { $in: ids } }), AuthSession.deleteMany({ userId: { $in: ids } })]);
    await User.deleteMany({ _id: { $in: ids } });
  }
  const response = await fetch(base + "/auth/register", { method: "POST", headers: { "Content-Type": "application/json", "X-SkyScout-Request": "1" }, body: JSON.stringify({ name: "Intelligence QA", email: `intelligence-qa-${randomBytes(6).toString("hex")}@example.test`, password: `Intelligence-${randomBytes(16).toString("base64url")}` }) });
  assert.equal(response.status, 201);
  const account = await response.json();
  userId = new mongoose.Types.ObjectId(account.user.id);
  const cookie = response.headers.getSetCookie()[0].split(";", 1)[0];
  const departureDate = "2026-11-08";
  const flight = await TrackedFlight.create({ userId, fingerprint: randomBytes(32).toString("hex"), origin: "DEL", destination: "BLR", departureDate, departureAt: `${departureDate}T10:00:00+05:30`, airline: "QA flight fixture", flightNumber: "QA 100", segments: [{ destination: { code: "BLR", time: `${departureDate}T13:00:00+05:30` } }], initialPrice: 6000, currentPrice: 6000, currency: "INR", status: "paused" });
  flightId = flight._id;
  await PriceObservation.create({ userId, trackedFlightId: flightId, price: 6000, currency: "INR", observedAt: new Date(), source: "qa_fixture" });
  const { farePayload: fare, destinationPayload: destination, ...browserEvidence } = await browserCheck(cookie);
  assert.ok(fare?.baseline && destination?.journey, `Browser did not receive both intelligence API responses: ${JSON.stringify({ fare: Boolean(fare?.baseline), destination: Boolean(destination?.journey), browserEvidence })}`);
  console.log(JSON.stringify({ endpoints: [`GET /api/tracked-flights/:id/fare-intelligence`, `GET /api/tracked-flights/:id/destination-intelligence?finalDestination=Koramangala`], fare: { currentFare: fare.baseline.currentFare, currency: fare.baseline.currency, source: fare.baseline.currentObservation?.source, observationCount: fare.baseline.observationCount, calendar: fare.calendarContext, research: { status: fare.eventIntelligence?.status, model: fare.eventIntelligence?.model, pressure: fare.eventIntelligence?.pressure, checkedAt: fare.eventIntelligence?.checkedAt, sources: fare.eventIntelligence?.sources?.slice(0, 3), sourceCount: fare.eventIntelligence?.sources?.length, excerpt: fare.eventIntelligence?.groundedText?.slice(0, 350) } }, destination: { airport: destination.destination?.airportCode, cityReports: destination.eventCount, finalDestination: destination.journey?.finalDestination, routing: destination.journey?.routing, research: { status: destination.journey?.research?.status, checkedAt: destination.journey?.research?.checkedAt, sources: destination.journey?.research?.sources?.slice(0, 3), sourceCount: destination.journey?.research?.sources?.length, excerpt: destination.journey?.research?.text?.slice(0, 350), certainty: destination.journey?.research?.certainty } }, browserEvidence }, null, 2));
  assert.equal(fare.baseline.currentFare, 6000);
  assert.equal(fare.priceHistory?.length, 1);
  assert.equal(browserEvidence.rendered.fareChart, true);
  assert.equal(browserEvidence.rendered.rawMarkdown, false);
  assert.equal(browserEvidence.rendered.destinationResearch, false);
} finally {
  if (browser) {
    browser.kill();
    await new Promise((resolve) => browser.once("exit", resolve));
  }
  if (profile.startsWith(path.resolve("..") + path.sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (userId) {
    await Promise.all([PriceObservation.deleteMany({ userId }), FareIntelligenceAnalysis.deleteMany({ userId }), Notification.deleteMany({ userId }), DisruptionPrediction.deleteMany({ userId }), TrackedFlight.deleteMany({ userId }), AuthSession.deleteMany({ userId })]);
    await User.deleteMany({ _id: userId });
  }
  await mongoose.disconnect();
}
