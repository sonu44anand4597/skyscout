import dotenv from "dotenv";
import { resolveDestination } from "../services/destinationResolver.js";
import { fetchDestinationReports } from "../services/destinationSources.js";
import { normalizeReports } from "../services/destinationAnalysis.js";

dotenv.config({ quiet: true });
for (const code of process.argv.slice(2)) {
  const destination = resolveDestination(code);
  if (!destination) { console.log(`${code}: unknown airport`); continue; }
  try {
    const fetched = await fetchDestinationReports(destination);
    const diagnostics = {};
    const events = normalizeReports(fetched.reports, destination, new Date(), diagnostics);
    console.log(JSON.stringify({ code, coverage: fetched.coverage, diagnostics, events: events.map(({ title, eventType, affectedAreas, sourceCount, severity, sources }) => ({ title, eventType, affectedAreas, sourceCount, severity, sourceHosts: sources.map((source) => new URL(source.url).hostname) })), samples: code === "MIA" ? fetched.reports.slice(0, 35).map((report) => ({ title: report.title, host: (() => { try { return new URL(report.link).hostname; } catch { return "invalid"; } })(), date: report.iso_date })) : undefined }));
  } catch (error) { console.log(JSON.stringify({ code, error: error.message })); }
}
