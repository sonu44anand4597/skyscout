import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";
import ProviderLease from "../models/ProviderLease.js";
import ProviderState from "../models/ProviderState.js";
import { fetchWeatherProduct } from "../services/weatherService.js";

dotenv.config();
const run = promisify(execFile);
const runId = process.env.SKYSCOUT_WEATHER_TEST_ID || randomUUID();
const station = `K${runId.replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase()}`;
const sharedKey = `weather:metar:${station}`;
const collection = () => mongoose.connection.collection("e2e_weather_cache");

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for the weather-cache check.");
await mongoose.connect(process.env.MONGODB_URI);
try {
  if (process.argv.includes("--child")) {
    await collection().updateOne({ _id: runId }, { $inc: { ready: 1 } });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await collection().findOne({ _id: runId })).ready < 2) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok((await collection().findOne({ _id: runId })).ready >= 2);
    axios.get = async () => {
      await collection().updateOne({ _id: runId }, { $inc: { providerCalls: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 750));
      return { data: [{ rawOb: `METAR ${station}`, reportTime: "2026-10-07T07:00:00Z" }] };
    };
    const result = await fetchWeatherProduct(station, "metar");
    assert.equal(result.report.rawOb, `METAR ${station}`);
    console.log(JSON.stringify({ fetchedAt: result.fetchedAt, stale: result.stale }));
  } else {
    await collection().insertOne({ _id: runId, ready: 0, providerCalls: 0 });
    const script = new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
    const children = await Promise.all([0, 1].map(() => run(process.execPath, [script, "--child"], {
      cwd: process.cwd(), env: { ...process.env, SKYSCOUT_WEATHER_TEST_ID: runId }, timeout: 30_000,
    })));
    const results = children.map(({ stdout }) => JSON.parse(stdout.trim().split("\n").at(-1)));
    assert.equal((await collection().findOne({ _id: runId })).providerCalls, 1);
    assert.equal(results[0].fetchedAt, results[1].fetchedAt);
    assert.ok(results.every((item) => !item.stale));
    console.log("Two API processes shared one METAR response from one provider call.");
  }
} finally {
  if (!process.argv.includes("--child")) {
    await collection().deleteOne({ _id: runId });
    await ProviderState.deleteOne({ key: sharedKey });
    await ProviderLease.deleteOne({ _id: sharedKey });
  }
  await mongoose.disconnect();
}
