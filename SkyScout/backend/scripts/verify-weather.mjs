// Live public aviation-weather smoke check; timestamps are provider observations.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { closeDatabase } from '../config/database.js';
import connectDB from '../config/database.js';
import { getRouteWeather } from '../services/weatherService.js';

const evidence = { executedAt: new Date().toISOString(), source: 'LIVE AviationWeather.gov METAR/TAF, not a weather forecast fixture' };
const output = process.env.QA_OUTPUT_DIR || '../docs/qa/production-2026-10-28';
try {
  await connectDB();
  const result = await getRouteWeather('JFK', 'LAX');
  evidence.airports = result.airports.map((airport) => ({ airport: airport.airport, station: airport.station,
    observationPresent: Boolean(airport.observation?.report), observedAt: airport.observation?.observedAt,
    forecastPresent: Boolean(airport.forecast?.report), forecastValidFrom: airport.forecast?.validFrom,
    forecastValidTo: airport.forecast?.validTo, metarFetchedAt: airport.metarFetchedAt, tafFetchedAt: airport.tafFetchedAt,
    metarStale: airport.metarStale, tafStale: airport.tafStale,
  }));
  for (const airport of evidence.airports) {
    assert.equal(airport.observationPresent, true); assert.ok(Number.isFinite(Date.parse(airport.observedAt)));
    assert.equal(airport.forecastPresent, true); assert.ok(airport.forecastValidFrom && airport.forecastValidTo);
    assert.equal(airport.metarStale, false); assert.equal(airport.tafStale, false);
  }
  console.log(JSON.stringify(evidence));
} catch (error) { evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  await closeDatabase();
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/weather.json`, JSON.stringify(evidence, null, 2));
}
