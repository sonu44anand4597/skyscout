import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, Brain, ChartNoAxesCombined, LogOut, Plane, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import toast from "react-hot-toast";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import AirportWeather from "../components/AirportWeather.jsx";
import DestinationIntelligence from "../components/DestinationIntelligence.jsx";
import FareIntelligence from "../components/FareIntelligence.jsx";
import ThemeToggle from "../components/layout/ThemeToggle.jsx";
import { useTheme } from "../context/theme.js";
import { readDashboardSelection, saveDashboardSelection } from '../utils/navigation.js';
import { resultsCache } from '../utils/resultsCache.js';

function money(value, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value || 0);
}

function Dashboard() {
  const { theme } = useTheme();
  const { user, signOut } = useAuth();
  const userId = user?.id;
  const navigate = useNavigate();
  const [flights, setFlights] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [histories, setHistories] = useState({});
  const [historyErrors, setHistoryErrors] = useState({});
  const [prediction, setPrediction] = useState(null);
  const [selectedFlightId, setSelectedFlightId] = useState(() => new URLSearchParams(window.location.search).get('flight') || readDashboardSelection(user?.id));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingId, setSavingId] = useState("");
  const [flightPage, setFlightPage] = useState(null);
  const [notificationPage, setNotificationPage] = useState(null);
  const [notificationVisibleCount, setNotificationVisibleCount] = useState(8);
  const [serverUnreadCount, setServerUnreadCount] = useState(0);
  const [serverActiveCount, setServerActiveCount] = useState(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const dashboardRequest = useRef(null);

  const loadDashboard = useCallback(async () => {
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    const request = (path) => apiRequest(path, { signal: controller.signal });
    setLoading(true);
    setLoadError("");
    try {
      const [flightResponse, notificationResponse] = await Promise.all([
        request("/tracked-flights"),
        request("/tracked-flights/notifications"),
      ]);
      const desiredId = new URLSearchParams(window.location.search).get('flight') || readDashboardSelection(userId);
      const trackedFlights = [...flightResponse.data];
      if (desiredId && !trackedFlights.some((flight) => flight._id === desiredId)) {
        try { trackedFlights.unshift((await request(`/tracked-flights/${encodeURIComponent(desiredId)}`)).data); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      const historyEntries = await Promise.all(trackedFlights.map(async (flight) => {
        try { return { id: flight._id, data: (await request(`/tracked-flights/${flight._id}/history`)).data }; }
        catch (error) { return { id: flight._id, error: error.message }; }
      }));
      if (controller.signal.aborted) return;
      setFlights(trackedFlights);
      setNotifications(notificationResponse.data);
      setFlightPage(flightResponse.pagination); setNotificationPage(notificationResponse.pagination);
      setServerUnreadCount(notificationResponse.unreadCount ?? notificationResponse.data.filter((item) => !item.read).length);
      setServerActiveCount(flightResponse.activeCount ?? flightResponse.data.filter((item) => item.status === 'active').length);
      setHistories((previous) => ({ ...previous, ...Object.fromEntries(historyEntries.filter((entry) => !entry.error).map((entry) => [entry.id, entry.data])) }));
      setHistoryErrors(Object.fromEntries(historyEntries.filter((entry) => entry.error).map((entry) => [entry.id, entry.error])));
      setSelectedFlightId((current) => trackedFlights.some((flight) => flight._id === current)
        ? current
        : trackedFlights.find((flight) => flight.status === "active")?._id || trackedFlights[0]?._id || "");
      setLoaded(true);
    } catch (error) { if (!controller.signal.aborted) { setLoadError(error.message); toast.error(error.message); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [userId]);

  useEffect(() => {
    const timer = setTimeout(loadDashboard, 0);
    return () => { clearTimeout(timer); dashboardRequest.current?.abort(); };
  }, [loadDashboard]);

  useEffect(() => { if (loaded) saveDashboardSelection(user?.id, selectedFlightId); }, [loaded, selectedFlightId, user?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFlightId) {
      return () => { cancelled = true; };
    }
    Promise.allSettled([
      apiRequest(`/tracked-flights/${selectedFlightId}/prediction`),
    ]).then(([predictionResult]) => {
      if (cancelled) return;
      setPrediction(predictionResult.status === "fulfilled" ? predictionResult.value : { available: false, message: "Delay estimate is temporarily unavailable." });
    });
    return () => { cancelled = true; };
  }, [selectedFlightId]);

  const unreadCount = serverUnreadCount;
  const activeCount = serverActiveCount;
  const predictionFlight = useMemo(() => flights.find((flight) => flight._id === selectedFlightId) || null, [flights, selectedFlightId]);

  async function updateFlight(id, changes) {
    setSavingId(id);
    try {
      await apiRequest(`/tracked-flights/${id}`, { method: "PATCH", body: changes });
      await loadDashboard();
      toast.success("Watchlist updated.");
    } catch (error) { toast.error(error.message); }
    finally { setSavingId(""); }
  }

  async function removeFlight(id) {
    if (!window.confirm("Remove this flight and its collected price history?")) return;
    try { await apiRequest(`/tracked-flights/${id}`, { method: "DELETE" }); resultsCache.untrack(id); await loadDashboard(); toast.success("Flight removed."); }
    catch (error) { toast.error(error.message); }
  }

  async function refreshFare(id) {
    setSavingId(id);
    try {
      const response = await apiRequest(`/tracked-flights/${id}/refresh`, { method: 'POST' });
      await loadDashboard();
      toast.success(response.message);
    } catch (error) { toast.error(error.message); }
    finally { setSavingId(''); }
  }

  async function markAllRead() {
    try { await apiRequest("/tracked-flights/notifications/read/all", { method: "PATCH" }); await loadDashboard(); }
    catch (error) { toast.error(error.message); }
  }

  async function loadMoreFlights() {
    if (moreLoading || !flightPage?.nextCursor) return;
    setMoreLoading(true);
    try {
      const response = await apiRequest(`/tracked-flights?cursor=${flightPage.nextCursor}`);
      const entries = await Promise.all(response.data.map(async (flight) => [flight._id, (await apiRequest(`/tracked-flights/${flight._id}/history`)).data]));
      setFlights((previous) => [...previous, ...response.data.filter((flight) => !previous.some((item) => item._id === flight._id))]);
      setHistories((previous) => ({ ...previous, ...Object.fromEntries(entries) })); setFlightPage(response.pagination);
    } catch (failure) { toast.error(failure.message); }
    finally { setMoreLoading(false); }
  }

  async function showMoreNotifications() {
    if (notificationVisibleCount >= notifications.length && notificationPage?.nextCursor) {
      try {
        const response = await apiRequest(`/tracked-flights/notifications?cursor=${notificationPage.nextCursor}`);
        setNotifications((previous) => [...previous, ...response.data]); setNotificationPage(response.pagination);
      } catch (failure) { toast.error(failure.message); return; }
    }
    setNotificationVisibleCount((count) => count + 8);
  }

  function selectIntelligenceFlight(id) {
    setPrediction(null);
    setSelectedFlightId(id);
    navigate({ search: `?flight=${encodeURIComponent(id)}` }, { replace: true });
  }

  async function logout() {
    try { await signOut(); navigate("/login", { replace: true }); }
    catch (error) { toast.error(error.message); }
  }

  if (!loading && loadError && !loaded) {
    return <main className="min-h-screen bg-slate-50 px-4 py-7 sm:px-8 lg:px-12"><div className="mx-auto max-w-3xl"><Link to="/" className="flex w-fit items-center gap-3 text-xl font-extrabold tracking-tight text-slate-900"><span className="rounded-xl bg-violet-700 p-2 text-white"><Plane size={20} /></span>SkyScout</Link><section role="alert" className="mt-12 rounded-3xl border border-amber-200 bg-white p-8 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Dashboard unavailable</p><h1 className="mt-2 text-2xl font-bold text-slate-900">We couldn’t load your flight workspace.</h1><p className="mt-3 text-sm leading-6 text-slate-600">{loadError}</p><div className="mt-6 flex flex-wrap gap-3"><button onClick={loadDashboard} className="rounded-xl bg-violet-700 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-800">Try again</button><Link to="/" className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Back to flight search</Link></div></section></div></main>;
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-7 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3 text-xl font-extrabold tracking-tight text-slate-900"><span className="rounded-xl bg-violet-700 p-2 text-white"><Plane size={20} /></span>SkyScout</Link>
          <div className="flex items-center gap-3"><span className="hidden text-sm text-slate-600 sm:block">{user?.name}</span><ThemeToggle /><button onClick={loadDashboard} aria-label="Refresh dashboard" className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 hover:bg-slate-100"><RefreshCw size={18} /></button><button onClick={logout} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"><LogOut size={17} /> Sign out</button></div>
        </header>

        {loadError && loaded && <p role="alert" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-5 text-amber-900">Could not refresh the dashboard: {loadError}. The last successfully loaded data is still shown.</p>}

        <section className="mt-9 flex flex-wrap items-end justify-between gap-5">
          <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Flight workspace</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Your dashboard</h1><p className="mt-2 text-slate-600">Your tracked fares and account notifications.</p></div>
          <Link to="/#flight-search" className="inline-flex items-center gap-2 rounded-xl bg-violet-700 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-800"><Plus size={18} /> Search flights</Link>
        </section>

        <section className="mt-7 grid gap-4 sm:grid-cols-3">
          {[
            { title: "Tracked flights", value: flightPage?.total ?? flights.length, icon: Plane, caption: "Across your watchlist" },
            { title: "Monitoring", value: activeCount, icon: ChartNoAxesCombined, caption: "Active price checks" },
            { title: "Unread notifications", value: unreadCount, icon: Bell, caption: "Price and monitoring updates" },
          ].map(({ title, value, icon: Icon, caption }) => <article key={title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-600">{title}</p><Icon size={19} className="text-violet-700" /></div><p className="mt-3 text-3xl font-bold text-slate-900">{loading ? "—" : value}</p><p className="mt-1 text-xs text-slate-500">{caption}</p></article>)}
        </section>

        <div className="mt-7 grid gap-6 xl:grid-cols-[1.7fr_1fr]">
          <section className="self-start rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-bold text-slate-900">Tracked flights</h2><p className="mt-1 text-sm text-slate-500">Fares refresh on the monitoring schedule.</p></div><span className="rounded-full bg-violet-50 px-3 py-1 text-sm font-semibold text-violet-700">{flights.length}</span></div>
            {loading ? <div className="mt-6 h-36 animate-pulse rounded-2xl bg-slate-100" /> : flights.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-slate-300 px-6 py-12 text-center"><Plane className="mx-auto text-slate-400" /><p className="mt-3 font-semibold text-slate-800">No tracked flights yet</p><p className="mt-1 text-sm text-slate-500">Search fares, then choose a flight to start monitoring it.</p><Link to="/#flight-search" className="mt-4 inline-block font-semibold text-violet-700">Search flights</Link></div> : <div className="mt-5 space-y-4">
              {flights.map((flight) => {
                const points = histories[flight._id] || [];
                const chart = points.map((point) => ({ observedAt: new Date(point.observedAt).getTime(), price: point.price }));
                const targetDraft = flight.targetPrice == null ? "" : String(flight.targetPrice);
                const observedPrices = [...points.map((point) => Number(point.price)), Number(flight.currentPrice)].filter(Number.isFinite);
                const lowestObserved = observedPrices.length ? Math.min(...observedPrices) : null;
                const highestObserved = observedPrices.length ? Math.max(...observedPrices) : null;
                const priceChange = Number(flight.currentPrice) - Number(flight.initialPrice);
                const priceChangePercent = Number(flight.initialPrice) > 0 ? (priceChange / Number(flight.initialPrice)) * 100 : null;
                const latestRisk = flight.latestPrediction?.riskLevel;
                return <article id={`tracked-flight-${flight._id}`} key={flight._id} className="scroll-mt-6 rounded-2xl border border-slate-200 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold text-slate-900">{flight.origin} <span className="text-violet-600">→</span> {flight.destination}</h3>{latestRisk && <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${latestRisk === "high" ? "bg-rose-100 text-rose-700" : latestRisk === "medium" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>{latestRisk} delay risk</span>}</div><p className="mt-1 text-sm text-slate-600">{flight.airline || "Airline unavailable"}{flight.flightNumber ? ` · ${flight.flightNumber}` : ""} · {flight.departureDate}</p><p className="mt-1 text-xs text-slate-500">{flight.lastCheckedAt ? `Last checked ${new Date(flight.lastCheckedAt).toLocaleString()}` : "First check scheduled"}{flight.lastCheckError ? ` · ${flight.lastCheckError}` : ""}</p>{flight.latestPrediction && <p className="mt-1 text-xs text-slate-500">Latest estimate {(flight.latestPrediction.probability * 100).toFixed(1)}% · {new Date(flight.latestPrediction.generatedAt).toLocaleString()}</p>}</div><div className="text-right"><p className="text-2xl font-bold text-slate-900">{money(flight.currentPrice, flight.currency)}</p><p className="text-xs text-slate-500">Last verified fare</p><p className="mt-1 text-xs text-slate-500">{flight.quoteObservedAt ? `Observed ${new Date(flight.quoteObservedAt).toLocaleString()}` : "Observation timestamp unavailable"}</p></div></div>
                  {flight.nextCheckAt && flight.status === "active" && <p className="mt-2 text-xs text-slate-500">Next check scheduled {new Date(flight.nextCheckAt).toLocaleString()}</p>}
                  <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"><label className="text-xs font-semibold text-slate-600">Target price<input key={`${flight._id}-${flight.targetPrice ?? "none"}`} type="number" min="1" defaultValue={targetDraft} placeholder="Optional" disabled={flight.status === "completed"} onBlur={(event) => { const value = event.target.value ? Number(event.target.value) : null; if (value !== flight.targetPrice) updateFlight(flight._id, { targetPrice: value }); }} className="mt-1 block w-36 rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal disabled:bg-slate-100 disabled:text-slate-500" /></label>{flight.status === "completed" ? <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">Completed</span> : <button disabled={savingId === flight._id} onClick={() => updateFlight(flight._id, { status: flight.status === "active" ? "paused" : "active" })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">{flight.status === "active" ? "Pause" : "Resume"}</button>}<button disabled={savingId === flight._id || flight.status !== "active"} onClick={() => refreshFare(flight._id)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Check fare</button><button onClick={() => selectIntelligenceFlight(flight._id)} aria-pressed={selectedFlightId === flight._id} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${selectedFlightId === flight._id ? "border-violet-700 bg-violet-50 text-violet-800" : "border-slate-300 text-slate-700"}`}>View intelligence</button><button onClick={() => removeFlight(flight._id)} aria-label="Remove tracked flight" className="rounded-lg border border-red-200 p-2 text-red-700 hover:bg-red-50"><Trash2 size={17} /></button></div>
                  {historyErrors[flight._id] && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">History could not be refreshed: {historyErrors[flight._id]}. Previously loaded observations are preserved. Use Refresh dashboard to retry.</p>}{chart.length > 1 ? <div className="mt-5 h-48"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><XAxis dataKey="observedAt" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={{ fontSize: 11, fill: theme === "dark" ? "#bac8d9" : "#64748b" }} tickFormatter={(value) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })} /><YAxis width={60} tick={{ fontSize: 11, fill: theme === "dark" ? "#bac8d9" : "#64748b" }} /><Tooltip contentStyle={{ backgroundColor: theme === "dark" ? "#253246" : "#fff", color: theme === "dark" ? "#edf2fa" : "#0f172a", borderColor: theme === "dark" ? "#526075" : "#e2e8f0", borderRadius: 12 }} labelFormatter={(value) => new Date(value).toLocaleString()} formatter={(value) => money(value, flight.currency)} /><Line type="monotone" dataKey="price" stroke={theme === "dark" ? "#c4a3ff" : "#6d28d9"} strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer></div> : <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">Price history will appear as SkyScout collects more observations.</p>}
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Lowest observed</p><p className="mt-1 text-sm font-bold text-slate-800">{lowestObserved === null ? "—" : money(lowestObserved, flight.currency)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Highest observed</p><p className="mt-1 text-sm font-bold text-slate-800">{highestObserved === null ? "—" : money(highestObserved, flight.currency)}</p></div>
                    <div className="col-span-2 rounded-xl bg-slate-50 p-3 sm:col-span-1"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Since tracking began</p><p className={`mt-1 text-sm font-bold ${priceChange < 0 ? "text-emerald-700" : priceChange > 0 ? "text-rose-700" : "text-slate-800"}`}>{priceChange > 0 ? "+" : ""}{money(priceChange, flight.currency)}{priceChangePercent === null ? "" : ` (${priceChangePercent > 0 ? "+" : ""}${priceChangePercent.toFixed(1)}%)`}</p></div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-slate-500"><p>Initial fare: <span className="font-semibold text-slate-700">{money(flight.initialPrice, flight.currency)}</span></p><p>Target: <span className="font-semibold text-slate-700">{flight.targetPrice ? money(flight.targetPrice, flight.currency) : "Not set"}</span></p></div>
                </article>;
              })}
            </div>}{flightPage?.nextCursor && <button onClick={loadMoreFlights} disabled={moreLoading} className="mt-4 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-violet-700 disabled:opacity-50">{moreLoading ? "Loading…" : "Load more tracked flights"}</button>}
          </section>

          <div className="space-y-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold text-slate-900">Notifications</h2><p className="mt-1 text-sm text-slate-500">Persistent updates for your tracked flights.</p></div>{unreadCount > 0 && <button onClick={markAllRead} className="text-xs font-semibold text-violet-700 hover:underline">Mark all read</button>}</div>{notifications.length === 0 ? <p className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Price and monitoring notifications will appear here.</p> : <ul className="mt-4 space-y-3">{notifications.slice(0, notificationVisibleCount).map((item) => <li key={item._id} className={`rounded-xl p-3 ${item.read ? "bg-slate-50" : "bg-violet-50"}`}><div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold text-slate-900">{item.title}</p>{!item.read && <button aria-label="Mark notification read" onClick={async () => { try { await apiRequest(`/tracked-flights/notifications/read/${item._id}`, { method: "PATCH" }); await loadDashboard(); } catch (failure) { toast.error(failure.message); } }} className="text-xs text-violet-700">Read</button>}</div><p className="mt-1 text-xs leading-5 text-slate-600">{item.message}</p><div className="mt-2 flex items-center justify-between gap-3"><p className="text-[11px] text-slate-400">{new Date(item.createdAt).toLocaleString()}</p>{item.trackedFlightId && <a className="text-[11px] font-semibold text-violet-700 hover:underline" href={`#tracked-flight-${item.trackedFlightId}`}>View flight</a>}</div></li>)}</ul>}{(notificationVisibleCount < notifications.length || notificationPage?.nextCursor) && <button onClick={showMoreNotifications} className="mt-3 text-xs font-semibold text-violet-700 underline">Show more notifications</button>}</section>
            <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-center gap-3">
                <span className="rounded-xl bg-violet-50 p-2.5 text-violet-700"><Brain size={19} /></span>
                <div>
                  <h2 className="font-bold text-slate-900">Delay estimate</h2>
                  <p className="text-xs text-slate-500">{prediction?.prediction?.inputSummary?.flightLeg ? `${prediction.prediction.inputSummary.flightLeg.origin} → ${prediction.prediction.inputSummary.flightLeg.destination} · first leg` : predictionFlight ? `${predictionFlight.origin} → ${predictionFlight.destination}` : "Flight intelligence"}</p>
                </div>
              </div>
              {predictionFlight && prediction?.available ? <div className="mt-4 rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated delay risk · {prediction.prediction.riskLevel}</p>
                <p className="mt-1 text-3xl font-bold text-violet-700">{(prediction.prediction.probability * 100).toFixed(1)}%</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">Model {prediction.prediction.modelVersion} · generated {new Date(prediction.prediction.generatedAt).toLocaleString()}</p>
                <p className="mt-2 text-xs text-slate-500">{prediction.prediction.inputSummary?.scope}</p>
                {prediction.prediction.inputSummary?.metrics && <p className="mt-2 text-xs leading-5 text-slate-500">Held-out evaluation · ROC-AUC {prediction.prediction.inputSummary.metrics.roc_auc?.toFixed(2)} · Brier skill {((prediction.prediction.inputSummary.metrics.brier_skill_score || 0) * 100).toFixed(1)}% · {prediction.prediction.inputSummary.evaluation?.testWindows?.toLocaleString()} test flights ({prediction.prediction.inputSummary.evaluation?.testPeriodStart} to {prediction.prediction.inputSummary.evaluation?.testPeriodEnd})</p>}
                {prediction.prediction.inputSummary?.evaluation?.testPeriodEnd && <p className="mt-2 text-xs leading-5 text-amber-800">Training records end {prediction.prediction.inputSummary.evaluation.testPeriodEnd}; newer flight periods have not been validated.</p>}
              </div> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">{predictionFlight ? prediction?.message === "There is insufficient historical data for this airline and route." ? "This flight is outside the trained model’s U.S. domestic nonstop route coverage, so no reliable delay probability is available." : prediction?.message || "Loading this flight’s delay estimate…" : "Track a flight to view available flight intelligence."}</p>}
              {prediction?.region === "IN" && prediction?.operationalContext && <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700"><p className="font-bold text-slate-900">Indian airline operating context</p><p className="mt-1">Official airline-level on-time performance: {prediction.operationalContext.otpPercent.toFixed(2)}% for {prediction.operationalContext.airlineCode}, reported {prediction.operationalContext.reportedDate}. This is an aggregate statistic, not this flight's delay probability, and it is not an input to the current LSTM.</p><a href={prediction.operationalContext.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-semibold text-violet-700 underline">Ministry of Civil Aviation source</a></div>}
              {predictionFlight && !prediction?.available && <p className="mt-2 text-xs leading-5 text-slate-500">{prediction?.region === "IN" ? "No validated Indian flight-level arrival-delay model is installed. Airport weather below remains available separately." : "The trained model uses historical U.S. domestic nonstop flights. Airport weather below remains available separately when stations publish reports."}</p>}
              <details className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-600">
                <summary className="w-fit cursor-pointer font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700">How is this calculated?</summary>
                <p className="mt-2">The installed LSTM estimates arrival delays of at least 15 minutes for supported U.S. domestic nonstop flights from historical schedule and earlier airline-route delay patterns. Indian airline OTP is displayed only as separate aggregate context; it is not a flight-level estimate. Live weather is shown separately and is not an input to the installed model.</p>
                {prediction?.prediction?.inputSummary?.evaluation?.testPeriodEnd && <p className="mt-2">The source history ends {prediction.prediction.inputSummary.evaluation.testPeriodEnd}. Model performance on newer periods is unknown.</p>}
                <p className="mt-2">This is a statistical model estimate based on historical flight and schedule data. It is not a guarantee that a flight will or will not be delayed.</p>
              </details>
            </section>
            <AirportWeather key={selectedFlightId} flightId={selectedFlightId} />
          </div>
        </div>
        <div className="mt-6"><FareIntelligence key={`fare-${selectedFlightId}`} flightId={selectedFlightId} flight={predictionFlight} /></div>
        <div className="mt-6"><DestinationIntelligence key={`destination-${selectedFlightId}`} flightId={selectedFlightId} /></div>
      </div>
    </main>
  );
}

export default Dashboard;
