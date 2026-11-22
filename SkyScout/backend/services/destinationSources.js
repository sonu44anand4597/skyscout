import { serpApiRequest } from './serpApi.js';

const NEWS_URL = "https://serpapi.com/search.json";
const MAX_RESULTS_PER_QUERY = 12;
const OFFICIAL_DOMAINS = { US: "gov", GB: "gov.uk", FR: "gouv.fr", IN: "gov.in", AU: "gov.au", CA: "gc.ca" };

export function destinationQueries(destination) {
  const city = destination.searchTerms?.at(-1) || destination.city;
  const officialDomain = OFFICIAL_DOMAINS[destination.countryCode];
  return [
    { group: "airport", q: `${destination.airportName} flight delay cancellation disruption when:7d` },
    { group: "airport", q: `${destination.airportCode} airport disruption closure when:7d` },
    { group: "local", q: `${city} protest demonstration traffic diversion when:7d` },
    { group: "transport", q: `${city} transport metro rail bus strike disruption when:7d` },
    { group: "weather", q: `${city} severe weather storm flood travel warning when:7d` },
    { group: "local", q: `${city} road closure major event traffic advisory when:7d` },
    ...(officialDomain ? [{ group: "official", q: `site:${officialDomain} ${city} travel traffic weather airport advisory when:7d` }] : []),
  ];
}

export async function fetchDestinationReports(destination, get = (_url, options) => serpApiRequest(options.params, { maxAttempts: 1 })) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("Destination news provider is not configured.");
  const queries = destinationQueries(destination);
  const settled = [];
  for (let offset = 0; offset < queries.length; offset += 3) {
  settled.push(...await Promise.allSettled(queries.slice(offset, offset + 3).map(async ({ q }) => {
    const response = await get(NEWS_URL, {
      params: { engine: "google_news", q, gl: destination.countryCode.toLowerCase(), hl: "en", api_key: apiKey },
      timeout: 20_000,
    });
    if (/hasn't returned any results for this query/i.test(response.data?.error || "")) return [];
    if (response.data?.error) throw new Error(String(response.data.error).slice(0, 120));
    if (response.data?.search_metadata?.status !== "Success") throw new Error(`Provider search status: ${response.data?.search_metadata?.status || "unknown"}`);
    return Array.isArray(response.data.news_results) ? response.data.news_results.slice(0, MAX_RESULTS_PER_QUERY) : [];
  })));
  }
  const coverage = {
    provider: "SerpApi Google News",
    attempted: queries.length,
    successful: settled.filter((result) => result.status === "fulfilled").length,
    failed: settled.filter((result) => result.status === "rejected").length,
    groups: queries.map((query, index) => ({ group: query.group, query: query.q, status: settled[index].status === "fulfilled" ? "checked" : "failed", results: settled[index].status === "fulfilled" ? settled[index].value.length : 0 })),
  };
  if (!coverage.successful) throw new Error("Destination intelligence sources could not be checked.");
  const reports = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  console.info("Destination retrieval", JSON.stringify({ key: destination.key, attempted: coverage.attempted, successful: coverage.successful, failed: coverage.failed, retrieved: reports.length }));
  return { reports, coverage, searchesCompleted: coverage.successful, searchesAttempted: coverage.attempted };
}
