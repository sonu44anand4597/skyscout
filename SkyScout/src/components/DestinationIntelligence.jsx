import { useEffect, useRef, useState } from "react";
import { ExternalLink, MapPin, RefreshCw, Route } from "lucide-react";
import { apiRequest } from "../api/client.js";
import IntelligenceEventCard from "./IntelligenceEventCard.jsx";

const FILTERS = ["All", "Local", "Transport", "Airport", "Weather", "Official"];
const FILTER_TYPES = { Local: ["PROTEST_OR_CIVIL_DISRUPTION", "MAJOR_CLOSURE"], Transport: ["TRANSPORT_STRIKE", "PUBLIC_TRANSPORT_DISRUPTION"], Airport: ["AIRPORT_DISRUPTION"], Weather: ["SEVERE_WEATHER", "NATURAL_HAZARD"] };
const LABELS = { AIRPORT_DISRUPTION: "Airport", TRANSPORT_STRIKE: "Transport strike", PROTEST_OR_CIVIL_DISRUPTION: "Local disruption", PUBLIC_TRANSPORT_DISRUPTION: "Public transport", SEVERE_WEATHER: "Severe weather", NATURAL_HAZARD: "Natural hazard", MAJOR_CLOSURE: "Road restriction", SECURITY_ADVISORY: "Official advisory" };

function CityReport({ event }) {
  return <article className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-500"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{LABELS[event.eventType] || "Travel report"}</span><span>{event.severity} potential disruption</span></div><h4 className="mt-3 text-sm font-bold text-slate-900">{event.title || event.headline}</h4><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-700">{event.summary}</p><p className="mt-2 text-xs text-slate-600">Area: {event.affectedAreas?.join(", ") || "not identified"} · {event.guidance || event.practicalGuidance}</p><details className="mt-3 border-t border-slate-100 pt-2 text-xs"><summary className="cursor-pointer font-semibold text-violet-700">Sources and evidence</summary><ul className="mt-2 space-y-1">{event.sources?.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-violet-700 underline">{source.name} <ExternalLink size={12} /></a></li>)}</ul><p className="mt-1 text-slate-500">A recent report does not confirm an incident remains active.</p></details></article>;
}

export default function DestinationIntelligence({ flightId }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [finalDestination, setFinalDestination] = useState("");
  const [submittedDestination, setSubmittedDestination] = useState("");
  const displayedReport = useRef(null);
  useEffect(() => {
    if (!flightId) return undefined;
    let cancelled = false;
    async function load() {
      setLoading(true); setError("");
      try {
        const query = submittedDestination ? `?finalDestination=${encodeURIComponent(submittedDestination)}` : "";
        const result = await apiRequest(`/tracked-flights/${flightId}/destination-intelligence${query}`, { timeoutMs: 60000 });
        if (!cancelled) {
          const next = result.journey?.research;
          const identity = `${flightId}:${submittedDestination.toLowerCase()}`;
          if (['grounded_result', 'no_qualifying_event'].includes(next?.status)) displayedReport.current = { identity, report: next };
          else if (result.journey && displayedReport.current?.identity === identity) result.journey.research = { ...displayedReport.current.report, stale: true, lastAttempt: next };
          setState(result);
        }
      } catch (failure) {
        if (!cancelled) setError(failure.message);
      } finally { if (!cancelled) setLoading(false); }
    }
    const timer = setTimeout(load, 0);
    const interval = submittedDestination ? null : window.setInterval(load, 30 * 60_000);
    return () => { cancelled = true; clearTimeout(timer); if (interval) window.clearInterval(interval); };
  }, [flightId, refreshCount, submittedDestination]);
  return <DestinationIntelligenceView flightId={flightId} state={state} loading={loading} error={error} finalDestination={finalDestination} onDestinationChange={setFinalDestination} onDestinationSubmit={() => setSubmittedDestination(finalDestination.trim())} onRefresh={() => setRefreshCount((count) => count + 1)} />;
}

export function DestinationIntelligenceView({ flightId, state, loading, error = "", onRefresh, finalDestination = "", onDestinationChange = () => {}, onDestinationSubmit = () => {} }) {
  const [filter, setFilter] = useState("All");
  const destination = state?.destination;
  const journey = state?.journey;
  const events = state?.events || [];
  const grounded = journey?.research?.events || [];
  const relevant = grounded.slice(0, 5);
  const visible = events.filter((event) => filter === "All" || (filter === "Official" ? event.sources?.some((source) => source.tier === "official") : FILTER_TYPES[filter]?.includes(event.eventType)));
  const filters = FILTERS.filter((item) => item === "All" || events.some((event) => item === "Official" ? event.sources?.some((source) => source.tier === "official") : FILTER_TYPES[item]?.includes(event.eventType)));
  return <section className="min-w-0 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6" aria-label="Destination intelligence">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="rounded-xl bg-violet-50 p-2.5 text-violet-700"><MapPin size={19} /></span><div><h2 className="font-bold text-slate-900">Destination intelligence</h2><p className="mt-0.5 text-xs text-slate-500">Arrival airport to your final destination</p></div></div><button type="button" onClick={onRefresh} disabled={!flightId || loading} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"><RefreshCw size={14} /> Refresh</button></div>
    {!flightId ? <p className="mt-4 text-sm text-slate-600">Select a tracked flight to view its destination briefing.</p> : <>
      <div className="mt-5 rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">Arrival airport</p><p className="mt-1 text-sm font-bold text-slate-900">{destination?.airportName || "Arrival airport"} · {destination?.airportCode || "—"}{destination?.city ? ` · ${destination.city}` : ""}</p><label htmlFor={`final-destination-${flightId}`} className="mt-4 block text-xs font-bold text-slate-700">Final destination</label><div className="mt-2 flex flex-wrap gap-2"><input id={`final-destination-${flightId}`} value={finalDestination} onChange={(event) => onDestinationChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onDestinationSubmit(); }} placeholder="Koramangala" className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" /><button type="button" onClick={onDestinationSubmit} disabled={loading || finalDestination.trim().length < 3} className="rounded-lg bg-violet-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">Check journey</button></div></div>
      {loading && <p className="mt-3 text-xs text-slate-500" role="status">Checking destination sources…</p>}
      {error && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900" role="alert">{error}</p>}
      {journey?.status === "available" && <div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="flex items-center gap-2"><Route size={17} className="text-violet-700" /><h3 className="text-sm font-bold text-slate-900">{journey.airportCode} to {journey.finalDestination}</h3></div>{journey.routing?.status === "available" ? <><p className="mt-2 text-xs text-slate-600">{journey.routing.provider} routes. Durations are provider estimates. {journey.routing.timingBasis}</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{journey.routing.routes?.map((route, index) => <div key={index} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs"><p className="font-bold text-slate-900">{route.summary || `Route ${index + 1}`}</p><p className="mt-1 text-slate-700">{route.distanceText} · {route.durationText}{route.trafficDurationText ? ` · traffic-aware ${route.trafficDurationText}` : ""}</p></div>)}</div></> : <p className="mt-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{journey.routing?.message || "Routing provider unavailable."}</p>}</div>}
      {journey?.status === "available" && <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4"><h3 className="text-sm font-bold text-slate-900">Grounded journey developments</h3><p className="mt-1 text-xs text-slate-600">{journey.research?.stale ? "Stale report · " : ""}{grounded.length} relevant sourced findings · Researched {journey.research?.checkedAt ? new Date(journey.research.checkedAt).toLocaleString("en-IN") : "not yet"}</p><p className="mt-1 text-xs text-slate-500">{journey.research?.certainty || "A city report alone cannot establish route impact."}</p>{journey.research?.lastAttempt && <p className="mt-2 text-xs text-amber-900">Latest research attempt: {journey.research.lastAttempt.status}. Earlier displayed evidence is retained.</p>}{grounded.length ? <><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{relevant.map((event) => <IntelligenceEventCard key={event.id} event={event} destination />)}</div>{grounded.length > 5 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-semibold text-violet-700">View all research ({grounded.length - 5} more)</summary><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{grounded.slice(5).map((event) => <IntelligenceEventCard key={event.id} event={event} destination />)}</div></details>}{journey.research?.searchSuggestionsHtml && <iframe title="Destination Google Search Suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={journey.research.searchSuggestionsHtml} className="mt-3 h-20 w-full border-0" />}</> : <p className="mt-3 text-xs text-slate-600">{journey.research?.message || (journey.research?.status === "no_qualifying_event" ? "No cited event passed the date and location checks." : journey.research?.status || "Research unavailable.")}</p>}</div>}
      <div className="mt-5 rounded-2xl border border-slate-200 p-4"><h3 className="text-sm font-bold text-slate-900">Recent city and airport reports</h3>{state?.available ? <><p className="mt-1 text-xs text-slate-600">{events.length} qualifying reports · {state.coverage?.successful ?? 0} source searches completed{state.stale ? " · stale results" : ""}</p>{events.length ? <><div className="mt-3 flex flex-wrap gap-2">{filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} aria-pressed={filter === item} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === item ? "bg-violet-700 text-white" : "bg-slate-100 text-slate-700"}`}>{item}</button>)}</div><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{visible.map((event, index) => <CityReport key={`${event.eventType}-${index}`} event={event} />)}</div></> : <p className="mt-3 text-xs text-slate-600">No qualifying recent reports from the checked sources. This does not establish that roads are clear.</p>}</> : <p className="mt-2 text-xs text-slate-600">{state?.message || "City report provider has not responded."} Journey routing and grounded research are shown independently above when available.</p>}</div>
    </>}
  </section>;
}
