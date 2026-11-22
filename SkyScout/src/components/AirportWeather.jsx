import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiRequest } from "../api/client.js";
import { forecastValidity } from '../utils/weatherFreshness.js';

function timeLabel(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : "Time unavailable";
}

function isOldObservation(value) {
  const observed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(observed) && Date.now() - observed > 90 * 60 * 1000;
}

export default function AirportWeather({ flightId }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);

  const refresh = useCallback(() => setRefreshCount((count) => count + 1), []);

  useEffect(() => {
    if (!flightId) {
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      setLoading(true);
      try {
        const response = await apiRequest(`/tracked-flights/${flightId}/weather`);
        if (!cancelled) { setWeather(response); setError(""); }
      } catch {
        if (!cancelled) setError("Weather refresh failed. Showing the last available report when possible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const timer = window.setInterval(load, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flightId, refreshCount]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Airport weather">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-900">Airport weather</h2>
          <p className="text-xs text-slate-500">Latest available METAR and TAF · checks every minute</p>
        </div>
        <button type="button" onClick={refresh} disabled={!flightId || loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50" aria-label="Refresh airport weather">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-amber-800" role="status">{error}</p>}
      {!weather?.available ? (
        <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">{weather?.airports?.map((airport) => airport.message).filter(Boolean).join(" ") || (flightId ? "Loading current airport reports…" : "Track a flight to view airport weather.")}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {weather.airports.map((airport) => {
            const old = isOldObservation(airport.observation?.observedAt);
            const validity = forecastValidity(airport.forecast);
            return (
              <div key={airport.airport} className="rounded-xl bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">{airport.airport} {airport.station ? `· ${airport.station}` : ""}</p>
                  {airport.observation?.flightCategory && <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-slate-700">{airport.observation.flightCategory}</span>}
                </div>
                {airport.observation && <>
                  <p className={`mt-1 text-xs ${old || airport.metarStale ? "text-amber-800" : "text-slate-500"}`}>
                    Observed {timeLabel(airport.observation.observedAt)}{old ? " · older than 90 minutes" : ""}{airport.metarStale ? " · source refresh delayed" : ""}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
                    <p>Visibility <span className="font-semibold text-slate-800">{airport.observation.visibilityMiles == null ? "Unavailable" : `${airport.observation.visibilityMiles}${airport.observation.visibilityIsAtLeast ? "+" : ""} mi`}</span></p>
                    <p>Wind <span className="font-semibold text-slate-800">{airport.observation.windSpeedKnots == null ? "Unavailable" : `${airport.observation.windSpeedKnots} kt${airport.observation.windDirectionDegrees == null ? "" : ` · ${airport.observation.windDirectionDegrees}°`}`}</span></p>
                    <p>Temperature <span className="font-semibold text-slate-800">{airport.observation.temperatureC == null ? "Unavailable" : `${airport.observation.temperatureC}°C`}</span></p>
                    <p>Conditions <span className="font-semibold text-slate-800">{airport.observation.conditions || airport.observation.cloudCover || "Not reported"}</span></p>
                  </div>
                  {airport.observation.report && <p className="mt-2 break-words text-xs leading-5 text-slate-600">METAR · {airport.observation.report}</p>}
                </>}
                {airport.forecast?.report && <details className="mt-2 text-xs leading-5 text-slate-600"><summary className="cursor-pointer font-semibold text-violet-700">View TAF forecast{validity === 'expired' ? ' · expired' : validity === 'upcoming' ? ' · not yet valid' : validity === 'unknown' ? ' · validity unavailable' : ''}</summary><p className="mt-1">Issued {timeLabel(airport.forecast.issuedAt)} · valid {timeLabel(airport.forecast.validFrom)} to {timeLabel(airport.forecast.validTo)}{airport.tafStale ? ' · source refresh delayed' : ''}</p><p className="mt-1 break-words">{airport.forecast.report}</p></details>}
                {!airport.observation?.report && !airport.forecast?.report && <p className="mt-2 text-xs text-slate-500">{airport.message}</p>}
                {airport.metarFetchedAt && <p className="mt-2 text-[11px] text-slate-400">Checked {timeLabel(airport.metarFetchedAt)}</p>}
              </div>
            );
          })}
          <p className="text-[11px] text-slate-400">Source: AviationWeather.gov. Reports update when stations publish them; they are not used by the current delay model.</p>
        </div>
      )}
    </section>
  );
}
