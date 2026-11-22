import { createHash } from "node:crypto";

const CATEGORIES = new Set(["holiday", "festival", "airline", "airport", "weather", "road", "strike", "concert", "sport", "fuel", "economic", "currency", "regulation", "demand", "capacity", "school", "conference", "security", "other"]);
const DIRECTIONS = new Set(["upward", "downward", "mixed", "uncertain"]);
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const clean = (value, limit = 300) => typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/\[\d+\]/g, '').replace(/\*\*|__|`|^#+\s*/g, "").replace(/\s+/g, " ").trim().slice(0, limit) : "";
const list = (value) => Array.isArray(value) ? value.map((item) => clean(item, 90)).filter(Boolean).slice(0, 8) : [];
const daysApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
const byteOffset = (text, index) => Buffer.byteLength(text.slice(0, index), 'utf8');
const contains = (haystack, needle) => Boolean(needle) && haystack.toLowerCase().includes(needle.toLowerCase());
const sourceUrl = (value) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|.*\.local$)/i.test(url.hostname) ? url.href : null; }
  catch { return null; }
};

// generateContent offsets are UTF-8 bytes within a candidate Part, not JS string indexes.
// Concatenate the same non-thought text as the SDK getter and relocate each Part's supports.
export function groundedResponse(response) {
  const candidate = response?.candidates?.[0];
  const metadata = candidate?.groundingMetadata;
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return { text: typeof response?.text === 'string' ? response.text : '', metadata };
  let text = '';
  const offsets = new Map();
  parts.forEach((part, index) => {
    if (typeof part.text !== 'string' || part.thought) return;
    offsets.set(index, { start: Buffer.byteLength(text, 'utf8'), length: Buffer.byteLength(part.text, 'utf8') });
    text += part.text;
  });
  const supports = (metadata?.groundingSupports || []).flatMap((support) => {
    const segment = support.segment;
    const offset = offsets.get(segment?.partIndex ?? 0);
    if (!offset) return [];
    if (!Number.isInteger(segment?.endIndex)) return [support];
    const start = segment.startIndex ?? 0;
    if (!Number.isInteger(start) || start < 0 || segment.endIndex <= start || segment.endIndex > offset.length) return [];
    return [{ ...support, segment: { ...segment, startIndex: offset.start + start, endIndex: offset.start + segment.endIndex } }];
  });
  return { text, metadata: metadata ? { ...metadata, groundingSupports: supports } : metadata };
}

function parseJson(text) {
  if (typeof text !== "string" || text.length > 35_000) return null;
  const unwrapped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(unwrapped);
    return Array.isArray(value) ? value : Array.isArray(value?.events) ? value.events : null;
  } catch {
    try { const value = JSON.parse(unwrapped.slice(unwrapped.indexOf('{'), unwrapped.lastIndexOf('}') + 1)); if (Array.isArray(value?.events)) return value.events; } catch { /* Try source-attributed labeled records below. */ }
    const starts = [...text.matchAll(/^(?:\*\*)?EVENT(?:\s+\d+)?(?:\*\*)?\s*$/gim)];
    if (!starts.length) return null;
    return starts.slice(0, 12).map((match, index) => {
      const start = match.index;
      const end = starts[index + 1]?.index || text.length;
      const block = text.slice(start, end);
      const field = (name) => block.match(new RegExp(`^\\s*(?:\\*\\*)?${name}\\s*:(?:\\*\\*)?\\s*(.+)$`, 'im'))?.[1]?.replace(/\[\d+\]/g, '').trim() || '';
      const date = (name) => field(name).match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
      return { title: field('Title'), category: field('Category').toLowerCase(), summary: field('Summary'), eventStart: date('Start'), eventEnd: date('End'), location: field('Location'),
        affectedAirports: field('Airports').split(/[,;]/).map((value) => value.trim()), affectedAirlines: field('Airlines').split(/[,;]/).map((value) => value.trim()).filter((value) => value && !/^none|null|unknown$/i.test(value)), affectedRoads: field('Roads').split(/[,;]/).map((value) => value.trim()).filter((value) => value && !/^none|null|unknown$/i.test(value)),
        impactDirection: field('Direction').toLowerCase(), impactExplanation: field('Mechanism'), sourceTitle: '', sourceUrl: '', publishedAt: date('Published'), __start: start, __end: end };
    });
  }
}

function citedSource(item, metadata, text) {
  const titleAt = text.indexOf(JSON.stringify(item.title));
  const supports = metadata?.groundingSupports || [];
  const precise = supports.filter((support) => Number.isInteger(support.segment?.startIndex) && Number.isInteger(support.segment?.endIndex));
  // Restrict attribution to citations overlapping this event's JSON object whenever offsets exist.
  const objectStart = item.__start ?? (titleAt >= 0 ? text.lastIndexOf('{', titleAt) : -1);
  const objectEnd = item.__end ?? (titleAt >= 0 ? text.indexOf('}', titleAt) + 1 : -1);
  const objectStartByte = objectStart >= 0 ? byteOffset(text, objectStart) : -1;
  const objectEndByte = objectEnd >= 0 ? byteOffset(text, objectEnd) : -1;
  const scoped = precise.length ? precise.filter((support) => objectStartByte >= 0 && support.segment.startIndex < objectEndByte && support.segment.endIndex > objectStartByte) : supports;
  const supported = new Set(scoped.flatMap((support) => support.groundingChunkIndices || []));
  const chunks = (metadata?.groundingChunks || []).flatMap((chunk, index) => supported.has(index) && sourceUrl(chunk.web?.uri) ? [{ title: clean(chunk.web.title, 160), url: sourceUrl(chunk.web.uri) }] : []);
  const requestedTitle = clean(item.sourceTitle, 160).toLowerCase();
  const requestedUrl = clean(item.sourceUrl, 1000);
  let requestedHost = "";
  try { requestedHost = new URL(requestedUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { /* The model may omit a URL. */ }
  return chunks.find((source) => source.url === requestedUrl || (requestedHost && new URL(source.url).hostname.replace(/^www\./, "").toLowerCase() === requestedHost) || (requestedHost && contains(source.title, requestedHost)) || (requestedTitle && (source.title.toLowerCase() === requestedTitle || contains(source.title, requestedTitle)))) || (item.__start !== undefined && precise.length && scoped.length ? chunks[0] : null) || null;
}

function relevanceFor(event, context) {
  const origin = String(context.origin || "").toUpperCase();
  const destination = String(context.destination || "").toUpperCase();
  const airline = clean(context.airline, 100);
  const places = [event.location, ...event.affectedAirports, ...event.affectedRoads].join(" ");
  const airportMatch = event.affectedAirports.some((code) => code === origin || code === destination);
  const airlineMatch = Boolean(airline && event.affectedAirlines.some((name) => contains(name, airline) || contains(airline, name)));
  const cityMatch = [context.originCity, context.destinationCity].some((city) => contains(places, city));
  const windowDays = context.kind === "destination" ? 1 : 7;
  const nearTravel = isoDate(context.travelDate) && ((event.eventStart <= context.travelDate && daysApart(event.eventStart, context.travelDate) <= windowDays) || (isoDate(event.eventEnd) && Date.parse(event.eventStart) <= Date.parse(context.travelDate) && Date.parse(event.eventEnd) >= Date.parse(context.travelDate)));
  const mechanism = event.impactExplanation.length >= 30;
  const routeText = (context.routes || []).flatMap((route) => [route.summary, ...(route.steps || [])]).join(" ").toLowerCase();
  const roadMatch = event.affectedRoads.some((road) => road.length >= 4 && routeText.includes(road.toLowerCase()));
  const score = (nearTravel ? 3 : 0) + (airportMatch ? 3 : 0) + (airlineMatch ? 2 : 0) + (cityMatch ? 1 : 0) + (mechanism ? 1 : 0) + (roadMatch ? 3 : 0);
  const marketCategory = ["fuel", "economic", "currency", "regulation", "demand", "capacity"].includes(event.category);
  const recentMarket = marketCategory && isoDate(context.today) && event.publishedAt && event.publishedAt <= context.today && daysApart(event.publishedAt, context.today) <= 30;
  const countries = [context.originCountry, context.destinationCountry].filter(Boolean);
  const countryNames = { IN: /india|indian/i, US: /united states|\bUS\b|american/i, GB: /united kingdom|british|\bUK\b/i };
  const namedCountry = Object.entries(countryNames).find(([, pattern]) => pattern.test(event.location))?.[0];
  const nationalScope = namedCountry ? !countries.length || countries.includes(namedCountry) : /global|international|industry|national/i.test(event.location);
  const level = airportMatch || airlineMatch || roadMatch ? "DIRECT" : cityMatch ? "RELATED" : "CONTEXT";
  const relevant = context.kind === "destination" ? nearTravel && (airportMatch || cityMatch || roadMatch) : (nearTravel && (airportMatch || airlineMatch || cityMatch) && mechanism) || (recentMarket && (nationalScope || airportMatch || airlineMatch) && mechanism);
  return { score: score + (level === "DIRECT" ? 6 : level === "RELATED" ? 3 : 0), relevant, level, roadMatch, reason: roadMatch ? "A named road appears in a provider route." : airportMatch ? "Names this flight's airport." : airlineMatch ? "Names this flight's airline." : cityMatch ? "Names the origin or destination city; route impact is unverified." : "National or industry market context; no demonstrated route-specific fare effect." };
}

export function normalizeGroundedEvents(text, metadata, context, researchedAt = new Date().toISOString()) {
  const parsed = parseJson(text);
  if (!parsed) return { status: "unstructured_result", events: [], excludedCount: 0, diagnostics: { candidateCount: 0, acceptedCount: 0, exclusions: { unparseable_response: 1 } } };
  const events = [];
  let excludedCount = 0;
  const exclusions = {};
  const exclude = (reason) => { excludedCount++; exclusions[reason] = (exclusions[reason] || 0) + 1; };
  for (const item of parsed.slice(0, 20)) {
    if (!item || typeof item !== "object") { exclude("invalid_record"); continue; }
    const source = citedSource(item, metadata, text);
    const title = clean(item.title, 120);
    const summary = clean(item.summary, 320);
    const eventStart = isoDate(item.eventStart) ? item.eventStart : null;
    if (isoDate(item.publishedAt) && isoDate(context.today) && item.publishedAt > context.today) { exclude('publication_in_future'); continue; }
    if (isoDate(item.eventEnd) && eventStart && item.eventEnd < eventStart) { exclude('event_ends_before_start'); continue; }
    if (!source || !title || !summary || !eventStart) { exclude(!source ? "no_matching_supported_source" : !eventStart ? "missing_or_invalid_event_date" : "missing_title_or_summary"); continue; }
    const event = {
      id: createHash("sha256").update([title, eventStart, source.url].join("|")).digest("hex").slice(0, 16),
      title, category: CATEGORIES.has(item.category) ? item.category : "other", summary,
      eventStart, eventEnd: isoDate(item.eventEnd) ? item.eventEnd : null,
      location: clean(item.location, 120), affectedAirports: list(item.affectedAirports).map((code) => code.toUpperCase()).filter((code) => /^[A-Z]{3}$/.test(code)),
      affectedAirlines: list(item.affectedAirlines), affectedRoads: list(item.affectedRoads),
      impactDirection: DIRECTIONS.has(item.impactDirection) ? item.impactDirection : "uncertain",
      impactExplanation: clean(item.impactExplanation, 250),
      relevance: null, evidenceStatus: "possible",
      sourceTitle: source.title || new URL(source.url).hostname, sourceUrl: source.url,
      publishedAt: isoDate(item.publishedAt) ? item.publishedAt : null, researchedAt,
    };
    const result = relevanceFor(event, context);
    if (!result.relevant) { exclude("outside_date_or_relevance_window"); continue; }
    if (events.some((prior) => prior.title.toLowerCase() === event.title.toLowerCase() && prior.eventStart === event.eventStart)) { exclude("duplicate"); continue; }
    event.relevance = { score: result.score, reason: result.reason, level: result.level };
    event.quantitativeAdjustment = 0;
    if (result.level === "CONTEXT") event.impactDirection = "uncertain";
    if (context.kind === "destination") event.routeImpactStatus = result.roadMatch ? "possibly_affected" : "not_verified_as_affected";
    events.push(event);
  }
  events.sort((a, b) => b.relevance.score - a.relevance.score || a.eventStart.localeCompare(b.eventStart));
  return { status: events.length ? "events_available" : "no_qualifying_event", events, excludedCount, diagnostics: { candidateCount: parsed.length, acceptedCount: events.length, excludedCount, exclusions } };
}
