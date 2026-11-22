const DAY = 86_400_000;
const MAX_AGE = 7 * DAY;
const EVENT_LIFETIME = DAY;

const NEWS_DOMAINS = new Set([
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "theguardian.com", "france24.com",
  "rfi.fr", "lemonde.fr", "franceinfo.fr", "leparisien.fr", "20minutes.fr", "dw.com",
  "aljazeera.com", "euronews.com", "thehindu.com", "indianexpress.com", "hindustantimes.com",
  "timesofindia.indiatimes.com", "ndtv.com", "channelnewsasia.com", "scmp.com", "abc.net.au",
  "cbc.ca", "ctvnews.ca", "nytimes.com", "washingtonpost.com", "cnn.com", "nbcnews.com",
  "cbsnews.com", "abcnews.go.com", "bloomberg.com", "ft.com", "sky.com", "thelocal.fr",
  "economictimes.indiatimes.com", "indiatoday.in", "aa.com.tr",
]);
const LOCAL_DOMAINS = new Set(["sortiraparis.com", "miamiherald.com", "nbcmiami.com", "wsvn.com", "local10.com", "wpbf.com", "gainesville.com", "nj.com"]);
const OFFICIAL_SUFFIXES = [".gov", ".gov.uk", ".gouv.fr", ".gov.in", ".nic.in", ".gov.au", ".gc.ca"];
const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "from", "with", "as", "after", "before", "amid", "over", "city", "france", "india", "airport", "travel", "disruption", "delays", "strike", "protest"]);
const AREA_PATTERN = /\b(?:[A-Z][\p{L}'-]+\s+){1,4}(?:Street|Road|Avenue|Boulevard|Place|Square|Station|Terminal|District|Bridge|Highway|Park)\b/gu;
const TRANSPORT_PATTERN = /\b(airport|flights?|airlines?|metro|subway|rail|trains?|buses?|tram|roads?|traffic|highway|taxis?|ferr(?:y|ies))\b/gi;

function plain(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function safeSource(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const official = OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
    const news = [...NEWS_DOMAINS].find((domain) => host === domain || host.endsWith(`.${domain}`));
    const local = [...LOCAL_DOMAINS].find((domain) => host === domain || host.endsWith(`.${domain}`));
    return official ? { url: parsed.toString(), host, publisherKey: host, tier: "official" }
      : news ? { url: parsed.toString(), host, publisherKey: news, tier: "news" }
        : local ? { url: parsed.toString(), host, publisherKey: local, tier: "local" } : null;
  } catch { return null; }
}

export function classifyReport(title, tier) {
  const t = plain(title);
  if (/\b(earthquake|wildfire|volcanic eruption|landslide|tsunami)\b/.test(t)) return "NATURAL_HAZARD";
  if (/\b(airport|airfield|flight|airline|terminal)\b/.test(t) && /\b(closed|closure|shut|grounded|cancelled|canceled|disruption|strike|suspended|delays?)\b/.test(t)) return "AIRPORT_DISRUPTION";
  if (/\b(strike|walkout|industrial action)\b/.test(t) && /\b(rail|train|metro|bus|transport|transit|airport|airline|taxi|subway)\b/.test(t)) return "TRANSPORT_STRIKE";
  if (/\b(protests?|demonstrations?|unrest|riots?|march(?:es)?)\b/.test(t) && /\b(traffic|roads?|transit|metro|train|station|airport|police|clashes?|closed|closure|diversion|disrupts?|disrupted|disruption|march|rally|violent|detained|curbs?)\b/.test(t)) return "PROTEST_OR_CIVIL_DISRUPTION";
  if (/\b(flood|storm|cyclone|hurricane|typhoon|blizzard|heatwave|heavy snow)\b/.test(t) && /\b(warning|alert|disruption|closure|emergency|strikes?|hits?|flooding|cancelled|canceled|closed)\b/.test(t)) return "SEVERE_WEATHER";
  if (/\b(rail|train|metro|bus|transport|transit|subway)\b/.test(t) && /\b(closed|closure|suspended|disruption|delays?)\b/.test(t)) return "PUBLIC_TRANSPORT_DISRUPTION";
  if (/\b(roads?|bridges?|highways?|stations?|traffic)\b/.test(t) && /\b(closed|closures?|shut|diversions?|detours?|curbs?|restrictions?)\b/.test(t)) return "MAJOR_CLOSURE";
  if (tier === "official" && /\b(advisory|warning|security alert)\b/.test(t)) return "SECURITY_ADVISORY";
  return null;
}

function titleWords(title, city) {
  return new Set(plain(title).replace(plain(city), " ").split(/[^a-z0-9]+/)
    .map((word) => word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word)));
}

function sameEvent(left, right, city) {
  if (left.eventType !== right.eventType || Math.abs(left.publishedAt - right.publishedAt) > 3 * DAY) return false;
  const a = titleWords(left.headline, city);
  const b = titleWords(right.headline, city);
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared >= 1 && shared / Math.max(Math.min(a.size, b.size), 1) >= 0.2;
}

const IMPACT = {
  AIRPORT_DISRUPTION: ["Airport or flight plans may be affected if the reported issue continues.", "Check the airport and airline's latest notices before leaving."],
  TRANSPORT_STRIKE: ["Some local or airport transfers may be affected.", "Check the transport operator's latest service information and allow extra time."],
  PROTEST_OR_CIVIL_DISRUPTION: ["Movement near reported gatherings may be affected.", "Check local authority updates and plan alternate routes where needed."],
  PUBLIC_TRANSPORT_DISRUPTION: ["Some transit journeys may be affected.", "Check the operator's current service status before travelling."],
  SEVERE_WEATHER: ["Weather may affect local movement and flight operations.", "Check official weather warnings and your carrier's latest status."],
  NATURAL_HAZARD: ["Travel conditions may change quickly near the reported hazard.", "Follow official local authority guidance and verify your itinerary."],
  MAJOR_CLOSURE: ["Reported closures may affect local routes.", "Check official road or transport updates before travelling."],
  SECURITY_ADVISORY: ["An authority has issued a report that may affect travel plans.", "Read the linked official advisory and follow its current instructions."],
};

function affectedAreas(headline, destination) {
  const areas = [...headline.matchAll(AREA_PATTERN)].map(([area]) => area.trim());
  const cityNames = destination.searchTerms || [destination.city];
  const namedBeforeEvent = cityNames.map((city) => headline.match(new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+((?:[A-Z][\\p{L}'-]+\\s+){1,3})(?:protest|demonstration|traffic|road)`, "u"))).find(Boolean);
  if (namedBeforeEvent) areas.push(namedBeforeEvent[1].trim());
  if (plain(headline).includes(plain(destination.airportName))) areas.push(destination.airportName);
  return [...new Set(areas)].slice(0, 6);
}

function affectedTransport(headline) {
  return [...new Set((headline.match(TRANSPORT_PATTERN) || []).map((item) => item.toLowerCase()))].slice(0, 6);
}

function impactAndGuidance(eventType, headline) {
  const t = plain(headline);
  if (eventType === "PROTEST_OR_CIVIL_DISRUPTION" && /\b(traffic|road|diversion|curb)\b/.test(t)) return ["Reported traffic restrictions or congestion may affect trips near the gathering.", "Check local traffic updates and allow extra time for affected routes."];
  if (eventType === "PROTEST_OR_CIVIL_DISRUPTION" && /\b(metro|rail|station|transit)\b/.test(t)) return ["Reported activity may affect nearby public transport access.", "Check the transport operator's latest service status before travelling."];
  if (eventType === "AIRPORT_DISRUPTION" && /\b(delay|cancel|ground|suspend)\b/.test(t)) return ["Reported flight delays or cancellations may affect travel through the airport.", "Verify your flight status with the airline before travelling to the airport."];
  return IMPACT[eventType];
}

export function normalizeReports(rawReports, destination, now = new Date(), diagnostics = {}) {
  const retrievedAt = new Date(now);
  const reports = [];
  const seenUrls = new Set();
  Object.assign(diagnostics, { retrieved: Array.isArray(rawReports) ? rawReports.length : 0, rejectedStale: 0, rejectedIrrelevant: 0, rejectedSource: 0, rejectedDuplicate: 0, accepted: 0, eventsProduced: 0 });
  for (const raw of Array.isArray(rawReports) ? rawReports : []) {
    const headline = String(raw?.title || "").trim().slice(0, 240);
    const source = safeSource(raw?.link);
    const publishedAt = new Date(raw?.iso_date || "");
    if (!headline || !source) { diagnostics.rejectedSource += 1; continue; }
    if (Number.isNaN(publishedAt.getTime()) || publishedAt > retrievedAt || retrievedAt - publishedAt > MAX_AGE) { diagnostics.rejectedStale += 1; continue; }
    if (seenUrls.has(source.url)) { diagnostics.rejectedDuplicate += 1; continue; }
    seenUrls.add(source.url);
    const locationText = plain(headline);
    if (!(destination.searchTerms || [destination.city]).some((term) => locationText.includes(plain(term))) && !locationText.includes(plain(destination.airportName)) && !new RegExp(`\\b${destination.airportCode.toLowerCase()}\\b`).test(locationText)) { diagnostics.rejectedIrrelevant += 1; continue; }
    const eventType = classifyReport(headline, source.tier);
    if (!eventType) { diagnostics.rejectedIrrelevant += 1; continue; }
    reports.push({ eventType, headline, publishedAt, source: {
      name: String(raw?.source?.name || source.host).slice(0, 80), url: source.url,
      publishedAt, retrievedAt, tier: source.tier, host: source.host, publisherKey: source.publisherKey,
    } });
  }
  diagnostics.accepted = reports.length;
  reports.sort((a, b) => b.publishedAt - a.publishedAt);
  const groups = [];
  for (const report of reports) {
    const group = groups.find((item) => sameEvent(item[0], report, destination.city));
    if (group) group.push(report);
    else groups.push([report]);
  }
  return groups.flatMap((group) => {
    const priority = { official: 3, news: 2, local: 1 };
    const independent = new Map();
    for (const item of group) if (!independent.has(item.source.publisherKey)) independent.set(item.source.publisherKey, item.source);
    const sources = [...independent.values()]
      .sort((a, b) => priority[b.tier] - priority[a.tier] || b.publishedAt - a.publishedAt);
    if (sources.length < 2 && !sources.some((source) => source.tier === "official")) return [];
    const first = group.find((item) => item.source.publisherKey === sources[0].publisherKey);
    const newest = group[0];
    const strongest = sources.some((source) => source.tier === "official") ? "high" : sources.length >= 3 ? "high" : "medium";
    const serious = /\b(closed|closure|evacuation|grounded|emergency)\b/.test(plain(first.headline));
    const severity = serious && (strongest === "high" || sources.length >= 2) ? "high"
      : ["AIRPORT_DISRUPTION", "SEVERE_WEATHER", "NATURAL_HAZARD", "TRANSPORT_STRIKE"].includes(first.eventType) ? "moderate" : "low";
    const [travellerImpact, practicalGuidance] = impactAndGuidance(first.eventType, first.headline);
    return [{
      eventType: first.eventType,
      title: first.headline,
      headline: first.headline,
      summary: first.headline,
      affectedAreas: [...new Set(group.flatMap((item) => affectedAreas(item.headline, destination)))],
      affectedTransport: [...new Set(group.flatMap((item) => affectedTransport(item.headline)))],
      travellerImpact,
      practicalGuidance,
      guidance: practicalGuidance,
      severity,
      confidence: strongest,
      publishedAt: newest.publishedAt,
      lastVerifiedAt: retrievedAt,
      expiresAt: new Date(retrievedAt.getTime() + EVENT_LIFETIME),
      status: "recent_report",
      sources: sources.map(({ name, url, publishedAt, retrievedAt, tier }) => ({ name, url, publishedAt, retrievedAt, tier })),
      sourceCount: sources.length,
    }];
  }).slice(0, 6).map((event, _index, events) => { diagnostics.eventsProduced = events.length; return event; });
}

export function overallDisruption(events) {
  const rank = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 };
  return events.reduce((level, event) => rank[event.severity] > rank[level] ? event.severity : level, "none");
}
