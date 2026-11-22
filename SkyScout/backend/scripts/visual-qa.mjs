import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import AuthSession from "../models/AuthSession.js";
import DisruptionPrediction from "../models/DisruptionPrediction.js";
import Notification from "../models/Notification.js";
import PriceObservation from "../models/PriceObservation.js";
import TrackedFlight from "../models/TrackedFlight.js";
import User from "../models/User.js";

dotenv.config();
const root = path.resolve("..");
const output = path.join(root, "qa-artifacts");
const browserProfile = path.join(output, "chrome-profile");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browserPort = 9229;
const runId = randomBytes(6).toString("hex");
let browser;
let socket;
let userId;

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the browser or dashboard.");
}

async function connectTab() {
  const tab = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: "PUT" });
    return response.ok ? response.json() : null;
  });
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for visual QA fixture cleanup.");
  await mkdir(output, { recursive: true });
  await mongoose.connect(process.env.MONGODB_URI);
  const password = `VisualQA-${randomBytes(18).toString("base64url")}`;
  const response = await fetch("http://127.0.0.1:5000/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json", "X-SkyScout-Request": "1" },
    body: JSON.stringify({ name: "Visual QA", email: `visual-qa-${runId}@example.test`, password }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  userId = new mongoose.Types.ObjectId(account.user.id);
  const cookie = response.headers.getSetCookie()[0].split(";", 1)[0];
  const departureDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const flight = await TrackedFlight.create({
    userId, fingerprint: randomBytes(32).toString("hex"), origin: "JFK", destination: "LAX",
    departureDate, departureAt: `${departureDate}T09:00:00-04:00`, airline: "American Airlines",
    flightNumber: "AA 100", segments: [{ from: "JFK", to: "LAX", flightNumber: "AA 100", durationMinutes: 360 }],
    initialPrice: 520, currentPrice: 460, currency: "USD", targetPrice: 425, status: "paused",
  });
  await PriceObservation.create({ userId, trackedFlightId: flight._id, price: 520, currency: "USD", observedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
  await PriceObservation.create({ userId, trackedFlightId: flight._id, price: 460, currency: "USD" });
  await Notification.create({ userId, trackedFlightId: flight._id, type: "PRICE_DROP", title: "Fare dropped by $60", message: "The observed fare moved from $520 to $460.", dedupeKey: `visual:${runId}`, read: false });

  browser = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${browserPort}`, `--user-data-dir=${browserProfile}`, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  const send = await connectTab();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  const [name, value] = cookie.split("=");
  await send("Network.setCookie", { name, value, url: "http://127.0.0.1:5173/", path: "/", httpOnly: true, sameSite: "Lax" });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/dashboard" });
  await waitFor(async () => {
    const result = await send("Runtime.evaluate", { expression: "document.querySelector('h1')?.textContent === 'Your dashboard' && document.querySelector('[id^=tracked-flight-]') !== null", returnByValue: true });
    return result.result.value;
  });
  await waitFor(async () => {
    const result = await send("Runtime.evaluate", { expression: "document.querySelector('[aria-label=\"Airport weather\"]')?.textContent.includes('Observed')", returnByValue: true });
    return result.result.value;
  });
  const results = [];
  for (const width of [360, 390, 768, 1024, 1280, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const dimensions = await send("Runtime.evaluate", { expression: "({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, weather: document.body.innerText.includes('Airport weather'), destination: document.querySelector('[aria-label=\"Destination intelligence\"]') !== null})", returnByValue: true });
    const record = { width, ...dimensions.result.value };
    results.push(record);
    if (width === 360 || width === 1440) {
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
      await writeFile(path.join(output, `dashboard-${width}.png`), Buffer.from(screenshot.data, "base64"));
    }
  }
  await send("Runtime.evaluate", { expression: "document.querySelector('button[aria-label=\"Switch to dark mode\"]')?.click()", returnByValue: true });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "document.documentElement.classList.contains('dark') && localStorage.getItem('skyscout-theme') === 'dark'", returnByValue: true })).result.value);
  const darkDashboard = await send("Runtime.evaluate", { expression: "({ background: getComputedStyle(document.querySelector('[aria-label=\"Destination intelligence\"]')).backgroundColor, page: getComputedStyle(document.body).backgroundColor })", returnByValue: true });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "document.querySelector('h1') !== null && document.documentElement.classList.contains('dark')", returnByValue: true })).result.value);
  const darkHome = await send("Runtime.evaluate", { expression: "({body: getComputedStyle(document.body).backgroundColor, navbar: getComputedStyle(document.querySelector('header')).backgroundColor, search: getComputedStyle(document.querySelector('#flight-search')).backgroundImage})", returnByValue: true });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/login" });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "document.querySelector('form') !== null && document.documentElement.classList.contains('dark')", returnByValue: true })).result.value);
  const darkAuth = await send("Runtime.evaluate", { expression: "({card: getComputedStyle(document.querySelector('form').parentElement).backgroundColor, input: getComputedStyle(document.querySelector('input')).backgroundColor})", returnByValue: true });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/results" });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "document.querySelector('h2') !== null && document.documentElement.classList.contains('dark')", returnByValue: true })).result.value);
  const darkResults = await send("Runtime.evaluate", { expression: "getComputedStyle(document.querySelector('h2').parentElement).backgroundColor", returnByValue: true });
  assert.equal(darkDashboard.result.value.background, "rgb(27, 38, 54)");
  assert.equal(darkHome.result.value.body, "rgb(15, 23, 36)");
  assert.ok(darkHome.result.value.navbar.includes("27, 38, 54"));
  assert.ok(darkHome.result.value.search.includes("15, 23, 36"));
  assert.equal(darkAuth.result.value.card, "rgb(27, 38, 54)");
  assert.equal(darkAuth.result.value.input, "rgb(23, 33, 51)");
  assert.equal(darkResults.result.value, "rgb(27, 38, 54)");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/login" });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "document.querySelector('button[aria-label=\"Switch to light mode\"]') !== null", returnByValue: true })).result.value);
  await send("Runtime.evaluate", { expression: "document.querySelector('button[aria-label=\"Switch to light mode\"]').click()", returnByValue: true });
  await waitFor(async () => (await send("Runtime.evaluate", { expression: "!document.documentElement.classList.contains('dark') && localStorage.getItem('skyscout-theme') === 'light'", returnByValue: true })).result.value);
  console.log(JSON.stringify({ darkDashboard: darkDashboard.result.value, darkHome: darkHome.result.value, darkAuth: darkAuth.result.value, darkResults: darkResults.result.value, lightRestored: true }));
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every((item) => item.scrollWidth <= item.clientWidth && item.weather && item.destination), "Dashboard has horizontal overflow or missing intelligence content.");
}

try { await main(); }
finally {
  socket?.close();
  browser?.kill();
  const relativeProfile = path.relative(root, browserProfile);
  if (relativeProfile === path.join("qa-artifacts", "chrome-profile") && path.basename(browserProfile) === "chrome-profile") {
    await rm(browserProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
  if (userId) {
    await Promise.all([
      PriceObservation.deleteMany({ userId }), Notification.deleteMany({ userId }),
      DisruptionPrediction.deleteMany({ userId }), TrackedFlight.deleteMany({ userId }),
      AuthSession.deleteMany({ userId }),
    ]);
    await User.deleteOne({ _id: userId });
  }
  await mongoose.disconnect();
}
