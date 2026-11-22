import axios from "axios";
import { normalizeIndianAirline } from "./predictionRegion.js";
import { logServiceError } from './safeLogging.js';

export const OTP_SOURCE = "https://www.civilaviation.gov.in/index.php/time-performance/time-performance-1";
const LABEL_CODES = { INDIGO: "6E", "AIR INDIA": "AI", "AIR INDIA EXPRESS": "IX", "AKASA AIR": "QP", SPICEJET: "SG", "ALLIANCE AIR": "9I" };
let cache = { expiresAt: 0, data: null };

export function parseOfficialOtp(html) {
  const text = String(html || "");
  const dateMatch = text.match(/Date\s*<div[^>]*>\s*On\s+(\d{1,2}\s+[A-Za-z]+\s+20\d{2})\s*<\/div>/i);
  const reportedAt = dateMatch ? new Date(`${dateMatch[1]} 00:00:00 GMT+0530`) : null;
  if (!reportedAt || Number.isNaN(reportedAt.getTime()) || reportedAt > new Date()) return null;
  const airlines = {};
  const pattern = /field--name-field-label[^>]*>\s*([^<]+)\s*<\/div>\s*<div[^>]*field--name-field-counting-number[^>]*>\s*(\d{1,3}(?:\.\d+)?)%\s*<\/div>/gi;
  for (const match of text.matchAll(pattern)) {
    const code = LABEL_CODES[match[1].trim().toUpperCase()];
    const percent = Number(match[2]);
    if (code && percent >= 0 && percent <= 100) airlines[code] = percent;
  }
  return Object.keys(airlines).length ? { reportedAt: reportedAt.toISOString(), reportedDate: dateMatch[1], airlines, sourceUrl: OTP_SOURCE, granularity: "airline-level aggregate on-time performance" } : null;
}

export async function getIndianOperationalContext(name, flightNumber, get = axios.get) {
  const code = normalizeIndianAirline(name, flightNumber);
  if (!code) return null;
  if (cache.expiresAt < Date.now()) {
    try {
      const response = await get(OTP_SOURCE, { timeout: 6000, headers: { "User-Agent": "SkyScout/1.0" } });
      const parsed = parseOfficialOtp(response.data);
      if (parsed) cache = { data: parsed, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    } catch (error) { logServiceError('india_operational_context_failed', error); }
  }
  if (!cache.data || Date.now() - new Date(cache.data.reportedAt).getTime() > 14 * 86_400_000) return null;
  const otpPercent = cache.data.airlines[code];
  return otpPercent === undefined ? null : { airlineCode: code, otpPercent, reportedAt: cache.data.reportedAt, reportedDate: cache.data.reportedDate, sourceUrl: OTP_SOURCE, granularity: cache.data.granularity, usedInPrediction: false };
}
