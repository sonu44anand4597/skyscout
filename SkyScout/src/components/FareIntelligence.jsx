import { useEffect, useRef, useState } from "react";
import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiRequest } from "../api/client.js";
import IntelligenceEventCard from "./IntelligenceEventCard.jsx";
import FareCalculation from './FareCalculation.jsx';
import { formatFare, formatSignedFare, formatSignedPercent } from "../utils/fareScenario.js";
import { useTheme } from "../context/theme.js";

const HORIZONS = [3, 7, 14];
const STATUS = {
  departure_reached: "No future booking days remain for this departure.",
  quota_exceeded: "Research quota reached. Fare evidence and calculations remain available.",
  cooldown: "A recent research request is still within its cooldown. The report already displayed is preserved.",
  previously_researched: "An earlier check completed, but its report was not retained. Fresh research is subject to provider cooldown.",
  not_configured: "GEMINI_API_KEY is missing on the server.",
  grounding_unavailable: "The provider response lacked usable search citations or suggestions.",
  unstructured_result: "The provider returned an unstructured report; no event was invented.",
  no_qualifying_event: "No sourced finding passed the date and relevance checks. This does not establish that fares will stay unchanged.",
  not_checked: "Automatic research is starting.",
  timeout: "Research timed out; try again later.",
  invalid_key: "The research provider rejected its credential.",
  unsupported_model: "The configured research model rejected this request.",
  unsupported_route: "The research location resolver does not cover this route.",
  disabled: "Research is disabled on this server.",
  provider_unavailable: "Research provider is temporarily unavailable.",
  research_in_progress: 'This itinerary is already being researched. Existing fare evidence remains available.',
};
const panel = "mt-5 rounded-2xl border border-slate-200 p-4";
const small = "mt-1 text-xs leading-5 text-slate-600";

function FareHistory({ history, currency, dark }) {
  const points = (history || []).map((item) => ({ ...item, time: new Date(item.observedAt).getTime() })).filter((item) => Number.isFinite(item.time));
  return <div className="mt-5 rounded-2xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-900">Observed fare history</h3><p className="mt-1 text-xs text-slate-500">Actual saved PriceObservation quotes only · {points.length} observations</p></div>{points.length > 1 && <p className="text-xs font-semibold text-slate-700">{formatFare(points[0].price, currency)} · {formatFare(points.at(-1).price, currency)}</p>}</div>
    {points.length ? <div className="mt-4 h-56 min-w-0 overflow-hidden" role="img" aria-label={`Observed fare chart with ${points.length} real price observations`}>
      <ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={dark ? "#415066" : "#e2e8f0"} strokeDasharray="3 3" />
        <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: dark ? "#bac8d9" : "#64748b" }} tickFormatter={(value) => new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} />
        <YAxis width={66} domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: dark ? "#bac8d9" : "#64748b" }} tickFormatter={(value) => new Intl.NumberFormat("en-IN", { notation: "compact" }).format(value)} />
        <Tooltip contentStyle={{ background: dark ? "#253246" : "#fff", color: dark ? "#edf2fa" : "#0f172a", borderColor: dark ? "#526075" : "#e2e8f0", borderRadius: 10 }} labelFormatter={(value) => new Date(value).toLocaleString("en-IN")} formatter={(value) => [formatFare(value, currency), "Observed fare"]} />
        <Line dataKey="price" name="Observed fare" type="linear" stroke={dark ? "#c4a3ff" : "#6d28d9"} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </LineChart></ResponsiveContainer>
    </div> : <p className="mt-4 text-sm text-slate-600">No comparable fare observations have been stored yet.</p>}
  </div>;
}

function DailyTooltip({ active, payload, currency, events }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const related = events.filter((event) => event.eventStart <= point.date && (event.eventEnd || event.eventStart) >= point.date);
  return <div className="max-w-xs rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-700 shadow-lg">
    <strong>Day {point.day}·{point.date}</strong>
    <p className="mt-2">Lower {formatFare(point.lower, currency)} · Central {formatFare(point.central, currency)} · Upper {formatFare(point.upper, currency)}</p>
    <p className="mt-1">{formatSignedFare(point.change, currency)} ({formatSignedPercent(point.changePercent)})</p>
    <p className="mt-1">{point.evidence}</p><p className="mt-1">{point.calculation.explanation}</p>
    <p className="mt-1">{related.length ? related.map((event) => event.title).join("; ") : "No dated event signal"}. Event effects are qualitative.</p>
  </div>;
}

export default function FareIntelligence({ flightId, flight }) {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [marketData, setMarketData] = useState(null);
  const [mode, setMode] = useState("assumption");
  const [market, setMarket] = useState("normal");
  const [horizon, setHorizon] = useState(7);
  const [selectedDay, setSelectedDay] = useState(0);
  const [loading, setLoading] = useState(false);
  const [researchLoading, setResearchLoading] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [error, setError] = useState("");
  const [researchNotice, setResearchNotice] = useState("");
  const activeRequest = useRef(0);
  const liveReport = useRef(null);
  const settings = useRef({ mode, market });
  useEffect(() => { settings.current = { mode, market }; }, [mode, market]);
  const query = `?mode=${mode}&market=${market}`;
  function merge(response) {
    if (["grounded_result", "no_qualifying_event"].includes(response.eventIntelligence?.status)) liveReport.current = response.eventIntelligence;
    else if (liveReport.current && ["quota_exceeded", "timeout", "provider_unavailable", "invalid_key", "grounding_unavailable", "unstructured_result"].includes(response.eventIntelligence?.status)) liveReport.current = { ...liveReport.current, stale: true, lastAttempt: { status: response.eventIntelligence.status, checkedAt: response.eventIntelligence.checkedAt } };
    return liveReport.current ? { ...response, eventIntelligence: liveReport.current } : response;
  }
  useEffect(() => {
    if (!flightId) return undefined;
    let cancelled = false;
    const requestId = ++activeRequest.current;
    const timer = setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const response = await apiRequest(`/tracked-flights/${flightId}/fare-intelligence${query}`, { timeoutMs: 60000 });
        if (!cancelled && activeRequest.current === requestId) setData(merge(response));
      } catch (failure) { if (!cancelled) setError(failure.message); }
      finally { if (!cancelled) setLoading(false); }
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [flightId, query]);
  useEffect(() => {
    if (!flightId) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setResearchLoading(true); setMarketLoading(true);
      const research = apiRequest(`/tracked-flights/${flightId}/fare-intelligence/research?mode=observed`, { method: "POST", timeoutMs: 60000 }).then((response) => {
        if (cancelled) return;
        if (["grounded_result", "no_qualifying_event"].includes(response.eventIntelligence?.status)) liveReport.current = response.eventIntelligence;
        setData((previous) => previous ? { ...previous, eventIntelligence: liveReport.current || response.eventIntelligence } : response);
        setResearchNotice(STATUS[response.eventIntelligence?.lastAttempt?.status || response.eventIntelligence?.status] || "");
      }).catch((failure) => { if (!cancelled) setResearchNotice(failure.message); }).finally(() => { if (!cancelled) setResearchLoading(false); });
      const offers = apiRequest(`/tracked-flights/${flightId}/fare-intelligence/market`, { timeoutMs: 60000 }).then(async (response) => {
        if (cancelled) return;
        setMarketData(response.market);
        if (response.market?.matchedFare) {
          const current = settings.current;
          const latest = await apiRequest(`/tracked-flights/${flightId}/fare-intelligence?mode=${current.mode}&market=${current.market}`);
          if (!cancelled && current.mode === settings.current.mode && current.market === settings.current.market) setData(merge(latest));
        }
      }).catch((failure) => { if (!cancelled) setMarketData({ status: "provider_unavailable", message: failure.message }); }).finally(() => { if (!cancelled) setMarketLoading(false); });
      await Promise.allSettled([research, offers]);
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [flightId]);
  async function refreshResearch() {
    const requestedSettings = { ...settings.current };
    setResearchLoading(true); setResearchNotice("");
    try {
      const response = await apiRequest(`/tracked-flights/${flightId}/fare-intelligence/research${query}`, { method: "POST", timeoutMs: 60000 });
      if (requestedSettings.mode === settings.current.mode && requestedSettings.market === settings.current.market) setData(merge(response));
      else setData((previous) => previous ? { ...previous, eventIntelligence: merge(response).eventIntelligence } : previous);
      setResearchNotice(STATUS[response.eventIntelligence?.lastAttempt?.status || response.eventIntelligence?.status] || "");
    } catch (failure) { setResearchNotice(failure.message); }
    finally { setResearchLoading(false); }
  }
  async function refreshMarket() {
    setMarketLoading(true);
    try {
      const response = await apiRequest(`/tracked-flights/${flightId}/fare-intelligence/market`, { timeoutMs: 60000 });
      setMarketData(response.market);
      setData(merge(await apiRequest(`/tracked-flights/${flightId}/fare-intelligence${query}`)));
    } catch (failure) { setError(failure.message); }
    finally { setMarketLoading(false); }
  }
  const baseline = data?.baseline;
  const research = data?.eventIntelligence;
  const currency = baseline?.currency || flight?.currency || "INR";
  const fare = baseline?.currentFare ?? flight?.currentPrice;
  const events = research?.events || [];
  const calendar = (data?.calendarContext?.events || []).map((event) => ({ ...event, id: `calendar-${event.date}-${event.title}`, eventStart: event.date }));
  const timeline = [...events, ...calendar].filter((event) => event.eventStart).sort((a, b) => a.eventStart.localeCompare(b.eventStart));
  const points = (data?.daily?.points || []).filter((point) => point.day <= horizon);
  const maxDay = data?.daily?.maxDay ?? 0;
  const maxAvailableDay = data?.daily?.points?.at(-1)?.day ?? 0;
  const displayedHorizon = Math.min(horizon, maxAvailableDay);
  const selected = points.find((point) => point.day === selectedDay) || points.at(-1);
  const direct = events.filter((event) => event.relevance?.level !== "CONTEXT");
  const context = events.filter((event) => event.relevance?.level === "CONTEXT");
  const matchingEvents = selected ? timeline.filter((event) => event.eventStart <= selected.date && (event.eventEnd || event.eventStart) >= selected.date) : [];
  const chartColors = { lower: theme === "dark" ? "#7dd3fc" : "#0284c7", central: theme === "dark" ? "#c4a3ff" : "#6d28d9", upper: theme === "dark" ? "#fcd34d" : "#b45309" };
  return <section className="min-w-0 [overflow-wrap:anywhere] rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6" aria-label="Fare Intelligence">
    <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-5"><div><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-violet-700">SkyScout / Fare Intelligence</p><h2 className="mt-2 text-xl font-bold text-slate-900 sm:text-2xl">{baseline?.route?.originCity || flight?.origin || "Origin"} <span className="text-violet-700">→</span> {baseline?.route?.destinationCity || flight?.destination || "Destination"}</h2><p className="mt-1 text-sm text-slate-500">{flight?.airline}·{flight?.departureDate}·{currency}·{baseline?.daysUntilDeparture ?? "—"} days before departure</p></div><ChartNoAxesCombined className="text-violet-700" size={24} /></div>
    {!flightId ? <p className={small}>Select a tracked flight.</p> : <>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs text-slate-500">{baseline?.currentObservation?.stale ? "Last observed fare · stale" : "Last observed fare"}</p><p className="mt-2 text-2xl font-bold text-slate-900">{formatFare(fare, currency)}</p><p className={small}>{baseline?.currentObservation?.observedAt ? new Date(baseline.currentObservation.observedAt).toLocaleString("en-IN") : "Quote timestamp pending"}</p></div><div className="rounded-2xl bg-violet-50 p-4"><p className="text-xs text-violet-700">Observed movement</p><p className="mt-2 text-lg font-bold text-slate-900">{baseline?.trend ? `${formatSignedFare(baseline.trend.observedChange, currency)} (${formatSignedPercent(baseline.trend.observedChangePercent)})` : "Tracking has started"}</p><p className={small}>{baseline?.observationCount || 0} quotes · {baseline?.bookingDayCount || 0} booking days</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Market evidence</p><p className="mt-2 text-lg font-bold text-slate-900">{marketData?.offers?.length || 0} comparable offers</p><p className={small}>{events.length} sourced findings · {calendar.length} calendar dates</p></div></div>
      <div className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-900">Day-wise fare outlook</h3><p className={small}>{mode === "assumption" ? "Exploratory assumptions · not an empirically validated forecast" : "Conditional estimates from this exact itinerary's saved quotes"}</p></div><div className="flex gap-1" aria-label="Fare horizon">{HORIZONS.map((day) => <button key={day} onClick={() => setHorizon(day)} disabled={day > maxAvailableDay} title={day > maxDay ? 'This horizon reaches or passes departure.' : day > maxAvailableDay ? 'More comparable booking-day history is required.' : `View up to Day ${day}`} aria-pressed={displayedHorizon === day} className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${displayedHorizon === day ? "bg-violet-700 text-white" : "bg-slate-100 text-slate-700"}`}>{day} days</button>)}</div></div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><label className="text-xs text-slate-700">Evidence view <select aria-label="Fare evidence view" value={mode} onChange={(event) => setMode(event.target.value)} className="ml-2 rounded-lg border border-slate-300 p-2"><option value="observed">Observed trend</option><option value="assumption">Conditional scenarios</option></select></label><label className="text-xs text-slate-700">Market conditions <select aria-label="Market conditions" disabled={mode !== "assumption"} value={market} onChange={(event) => setMarket(event.target.value)} className="ml-2 rounded-lg border border-slate-300 p-2"><option value="normal">Normal market</option><option value="upward">Upward pressure</option><option value="downward">Downward pressure</option></select></label>{loading && <span className="text-xs text-slate-500" role="status">Calculating·</span>}</div>
        {points.length > 1 ? <div className="mt-4 h-72 min-w-0 overflow-hidden" role="img" aria-label="Interactive day-wise fare scenario graph"><ResponsiveContainer width="100%" height="100%"><LineChart data={points} onClick={(state) => { const day = Number(state?.activeLabel); if (Number.isInteger(day) && points.some((point) => point.day === day)) setSelectedDay(day); }} margin={{ top: 15, right: 12, left: 4, bottom: 5 }}><CartesianGrid stroke={theme === "dark" ? "#415066" : "#e2e8f0"} strokeDasharray="3 3" /><XAxis dataKey="day" type="number" domain={[0, Math.min(horizon, data?.daily?.maxDay || 0)]} allowDecimals={false} tickFormatter={(value) => `Day ${value}`} tick={{ fontSize: 11 }} /><YAxis width={70} tickFormatter={(value) => new Intl.NumberFormat("en-IN", { notation: "compact" }).format(value)} domain={["auto", "auto"]} tick={{ fontSize: 11 }} /><Tooltip content={<DailyTooltip currency={currency} events={timeline} />} /><Legend wrapperStyle={{ fontSize: 11 }} />{Object.entries(chartColors).map(([key, color]) => <Line key={key} dataKey={key} name={`${key[0].toUpperCase()}${key.slice(1)} scenario`} stroke={color} strokeWidth={key === "central" ? 3 : 1.5} strokeDasharray={key === "central" ? undefined : "4 3"} dot={{ r: 3 }} isAnimationActive={false} />)}{points.filter((point) => timeline.some((event) => event.eventStart === point.date)).map((point) => <ReferenceLine key={point.day} x={point.day} stroke="#94a3b8" strokeDasharray="3 3" label={{ value: "Event", fontSize: 10 }} />)}<ReferenceLine x={0} stroke="#64748b" label={{ value: "Observed", fontSize: 10 }} /></LineChart></ResponsiveContainer></div> : <p className="mt-4 text-xs leading-5 text-slate-600">{baseline?.guidanceReason || "Loading saved quotes..."} {data?.daily?.maxDay > 0 && mode === "observed" && <button onClick={() => setMode("assumption")} className="font-semibold text-violet-700 underline">Explore transparent assumptions</button>}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Select fare day">{points.map((point) => <button key={point.day} onClick={() => setSelectedDay(point.day)} aria-pressed={selected?.day === point.day} className={`rounded-lg border px-2.5 py-1.5 text-xs ${selected?.day === point.day ? "border-violet-700 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}>Day {point.day}</button>)}</div>
        {selected && <div className="mt-4 rounded-xl bg-slate-50 p-4" aria-label="Selected day analysis"><div className="flex flex-wrap justify-between gap-3"><div><p className="text-xs font-bold text-violet-700">Day {selected.day}·{selected.date}</p><p className="mt-2 text-xl font-bold text-slate-900">{formatFare(selected.central, currency)}</p><p className={small}>{formatSignedFare(selected.change, currency)}·{formatSignedPercent(selected.changePercent)} from baseline</p></div><div className="text-xs text-slate-600"><p>Lower {formatFare(selected.lower, currency)}</p><p className="mt-1">Upper {formatFare(selected.upper, currency)}</p><p className="mt-1">{selected.evidence}</p></div></div><p className={small}>{selected.calculation.explanation}</p>{matchingEvents.map((event) => <p key={event.id} className={small}><a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">{event.title}</a> · qualitative context, numerical adjustment {formatFare(0, currency)}</p>)}</div>}
        <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer font-semibold text-violet-700">Daily values and evidence requirements</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["Day", "Date", "Lower", "Central", "Upper", "Change", "%"].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{points.map((point) => <tr key={point.day}><td className="p-2">{point.day}</td><td className="p-2 whitespace-nowrap">{point.date}</td><td className="p-2">{formatFare(point.lower, currency)}</td><td className="p-2">{formatFare(point.central, currency)}</td><td className="p-2">{formatFare(point.upper, currency)}</td><td className="p-2">{formatSignedFare(point.change, currency)}</td><td className="p-2">{formatSignedPercent(point.changePercent)}</td></tr>)}</tbody></table></div>{baseline?.outlookAvailability?.map((item) => <p key={item.daysAhead} className="mt-2">{item.daysAhead}-day: {item.reason}</p>)}</details>
      </div>
      <FareHistory history={data?.priceHistory} currency={currency} dark={theme === "dark"} />
      <div className={panel}><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-900">Comparable flight offers</h3><p className={small}>Same route, departure date, passenger count, cabin and currency; alternative itineraries are separate from historical evidence.</p></div><button onClick={refreshMarket} disabled={marketLoading} aria-label="Refresh current fare and comparable offers" className="rounded-lg border border-slate-300 p-2 text-slate-700 disabled:opacity-50"><RefreshCw size={15} /></button></div>{marketLoading && <p className={small} role="status">Checking real flight offers·</p>}{marketData?.offers?.length ? <><p className={small}>{marketData.stale ? "Stale saved offers" : "Provider quotes"}·{new Date(marketData.quotedAt).toLocaleString("en-IN")}·{marketData.matchStatus === "exact_itinerary" ? "Selected itinerary matched" : "Selected flight not returned; saved fare retained"}</p><div className="mt-4 h-60 min-w-0 overflow-hidden" role="img" aria-label="Comparable flight price graph"><ResponsiveContainer width="100%" height="100%"><BarChart data={marketData.offers.slice(0, 12)}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} angle={-15} height={58} /><YAxis width={65} tick={{ fontSize: 10 }} /><Tooltip contentStyle={{ borderRadius: 12, background: theme === "dark" ? "#253246" : "white" }} formatter={(value) => [formatFare(value, currency), "Provider quote"]} /><Bar dataKey="price" fill={chartColors.central} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div><details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer font-semibold text-violet-700">Compare prices and stops</summary>{marketData.offers.map((offer) => <p key={offer.id} className="mt-2">{offer.airline}·{offer.flightNumber}·{offer.departure}·{offer.stops} stops · {formatFare(offer.price, currency)} ({formatSignedFare(offer.difference, currency)}){offer.selected ? " · selected itinerary" : ""}</p>)}</details></> : !marketLoading && <p className={small}>{marketData?.message || "No eligible offers returned by the flight provider."}</p>}</div>
      <div className={panel}><h3 className="text-sm font-bold text-slate-900">News and event timeline</h3><p className={small}>Dated context near travel; no automatic event surcharge is applied.</p><div className="mt-3 flex gap-3 overflow-x-auto pb-2">{timeline.map((event) => <a key={event.id} href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="min-w-44 max-w-56 shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs"><p className="font-bold text-violet-700">{event.eventStart}</p><p className="mt-1 font-semibold text-slate-900">{event.title}</p><p className="mt-1 text-slate-500">{event.relevance?.level || "Verified calendar date"} · qualitative</p></a>)}</div>{!timeline.length && <p className={small}>{researchLoading ? "Researching dated events automatically..." : "No qualifying dated evidence has returned."}</p>}</div>
      <div className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-900">Market intelligence</h3><p className={small}>{direct.length} direct or related findings · {context.length} broader context · {researchLoading ? "Researching automatically..." : research?.checkedAt ? `Researched ${new Date(research.checkedAt).toLocaleString("en-IN")}` : "Research pending"}{research?.stale ? " · stale evidence" : ""}</p></div><button onClick={refreshResearch} disabled={researchLoading} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700 disabled:opacity-50"><RefreshCw size={14} />Refresh research</button></div>{direct.length > 0 && <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">{direct.slice(0, 5).map((event) => <IntelligenceEventCard key={event.id} event={event} />)}</div>}{direct.length > 5 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-semibold text-violet-700">More sourced findings</summary><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{direct.slice(5).map((event) => <IntelligenceEventCard key={event.id} event={event} />)}</div></details>}{context.length > 0 && <div className="mt-4"><p className="text-xs font-bold text-slate-700">Broader market context · route-specific effect unverified</p><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{context.map((event) => <IntelligenceEventCard key={event.id} event={event} />)}</div></div>}{!events.length && <p className={small}>{researchNotice || STATUS[research?.status] || "No validated research report returned."}</p>}{events.length > 0 && researchNotice && <p className={small}>{researchNotice}</p>}{research?.searchSuggestionsHtml && <iframe title="Google Search Suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={research.searchSuggestionsHtml} className="mt-3 h-24 w-full border-0" />}</div>
      <div className={panel}><h3 className="text-sm font-bold text-slate-900">Verified calendar context</h3>{calendar.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{calendar.map((event) => <div key={event.id} className="rounded-xl bg-slate-50 p-3 text-xs text-slate-700"><strong>{event.title}·{event.date}</strong><p className="mt-1">{event.location}·{event.explanation}</p><a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-violet-700 underline">{event.sourceName}</a></div>)}</div> : <p className={small}>{data?.calendarContext?.reason || "The installed calendar has no matching nearby national holiday. Regional and school calendars have not been verified."}</p>}</div>
      <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="text-xs font-bold uppercase text-violet-700">Booking guidance</p><h3 className="mt-1 text-lg font-bold text-slate-900">{marketData?.matchedFare && fare > marketData.matchedFare ? "A lower matched quote was found" : baseline?.trend?.direction === "down" ? "Observed fares have fallen" : baseline?.trend?.direction === "up" ? "Observed fares have risen" : "Compare current offers and monitor"}</h3><p className={small}>{baseline?.daysUntilDeparture <= 1 ? "Departure is close; no future booking-day scenario is available. " : ""}Observed direction: {baseline?.trend?.direction || "not established"}. {baseline?.currentObservation?.stale ? "The saved quote is stale. " : ""}No validated model establishes a buy-or-wait recommendation. News signals do not guarantee a fare change.</p></div>
      <FareCalculation selected={selected} baseline={baseline} evaluation={data?.evaluation} horizon={displayedHorizon} currency={currency} />
      <details className="mt-4 text-xs text-slate-600"><summary className="cursor-pointer font-semibold text-violet-700">Provider status and diagnostics</summary>{error && <p className="mt-2" role="alert">{error}</p>}<p className="mt-2">Monitoring {data?.monitoring?.status || flight?.status}·{data?.monitoring?.lastCheckError || "No recorded check error"}. Next scheduled check: {data?.monitoring?.nextCheckAt ? new Date(data.monitoring.nextCheckAt).toLocaleString("en-IN") : "not scheduled"}.</p><p className="mt-2">Research status: {research?.lastAttempt?.status || research?.status || "pending"}. {researchNotice}</p><p className="mt-2">Report storage: {research?.storageAuthorized ? "Authorized persistent storage enabled" : "Google grounding storage authorization is not configured; reports remain visible in this page only."}</p><pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify({ research: research?.diagnostics, market: marketData?.lastAttempt || (!marketData?.offers ? marketData : { status: marketData.status, checkedAt: marketData.checkedAt, quotedAt: marketData.quotedAt }), generatedAt: baseline?.generatedAt }, null, 2)}</pre></details>
    </>}
  </section>;
}
