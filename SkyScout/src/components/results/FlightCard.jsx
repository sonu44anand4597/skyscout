import { Clock, Plane } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../../context/AuthContext.jsx";
import { apiRequest } from "../../api/client.js";

function FlightCard({ flight, searchData, onChooseOutbound, chooseLabel = "Choose outbound", farePreviewLabel = "Outbound fare preview", choosingOutbound = false, initialTracked = false, onTracked }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [targetPrice, setTargetPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tracked, setTracked] = useState(initialTracked);
  const [bookingOptions, setBookingOptions] = useState(null);
  const [bookingBusy, setBookingBusy] = useState(false);
  const duration = flight.durationMinutes == null
    ? "Duration unavailable"
    : `${Math.floor(flight.durationMinutes / 60)}h ${flight.durationMinutes % 60}m`;
  const price = new Intl.NumberFormat("en-IN", { style: "currency", currency: flight.currency || "INR", maximumFractionDigits: 0 }).format(flight.price);

  async function trackFlight() {
    const pendingTrack = { ...flight, departureDate: searchData.departure, returnDate: searchData.returnDate || null, tripType: searchData.tripType, adults: searchData.adults, children: searchData.children, infants: searchData.infants, travelClass: searchData.travelClass, targetPrice: targetPrice ? Number(targetPrice) : null };
    if (!user) {
      navigate("/login", { state: { from: "/results", pendingTrack } });
      return;
    }
    setBusy(true);
    try {
      const saved = await apiRequest("/tracked-flights", { method: "POST", body: pendingTrack });
      setTracked(true);
      onTracked?.(flight.id, saved.data?._id);
      toast.success("Flight added to your watchlist.");
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function loadBookingOptions() {
    if (!flight.bookingRef) return;
    setBookingBusy(true);
    try { setBookingOptions((await apiRequest(`/flights/booking-options/${flight.bookingRef}`, { method: "POST", timeoutMs: 45000 })).data); }
    catch (error) { toast.error(error.message); }
    finally { setBookingBusy(false); }
  }

  return (
    <article className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm transition hover:border-violet-300 hover:shadow-xl">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-4">
          {flight.airlineLogo ? <img src={flight.airlineLogo} alt="" className="h-11 w-11 rounded-xl object-contain" /> : <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-100 font-bold text-violet-700">{flight.airline?.slice(0, 2) || "✈"}</div>}
          <div><h2 className="font-bold text-slate-900">{flight.airline || "Airline unavailable"}</h2><p className="text-sm text-slate-500">{flight.flightNumber || "Flight number unavailable"} · {flight.travelClass || "Class unavailable"}</p></div>
        </div>
        <div className="text-right"><p className="text-2xl font-bold text-slate-900">{price}</p><p className="text-sm text-slate-500">{onChooseOutbound ? farePreviewLabel : "per itinerary"}</p></div>
      </div>

      {(flight.roundTripLegs || (flight.multiCityComplete ? flight.journeyLegs : null))?.length ? <div className="grid gap-4 px-6 py-6 sm:px-8 md:grid-cols-2">{(flight.roundTripLegs || flight.journeyLegs).map((leg, index) => <div key={leg.direction || leg.legNumber || index} className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-violet-700">{leg.direction || `City leg ${leg.legNumber}`}</p><div className="flex items-center justify-between gap-3"><div><p className="text-xl font-bold text-slate-900">{(leg.departure || leg.departureAt)?.slice(-5) || "Time unavailable"}</p><p className="font-semibold text-slate-600">{leg.from || "—"}</p></div><div className="text-center text-xs text-slate-500">{leg.durationMinutes == null ? "Duration unavailable" : `${Math.floor(leg.durationMinutes / 60)}h ${leg.durationMinutes % 60}m`}<br />{leg.stopsLabel || "Stops unavailable"}</div><div className="text-right"><p className="text-xl font-bold text-slate-900">{(leg.arrival || leg.arrivalAt)?.slice(-5) || "Time unavailable"}</p><p className="font-semibold text-slate-600">{leg.to || "—"}</p></div></div><p className="mt-3 text-xs text-slate-500">{leg.airline || "Airline unavailable"} · {leg.flightNumber || "Flight number unavailable"}</p></div>)}</div> : <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-7 sm:px-8">
        <div><p className="text-3xl font-bold text-slate-900">{flight.departure || "—"}</p><p className="mt-1 font-semibold text-slate-600">{flight.from || "—"}</p><p className="text-xs text-slate-500">{flight.fromName || "Airport name unavailable"}</p></div>
        <div className="flex min-w-24 flex-col items-center text-slate-500"><span className="flex items-center gap-2 text-sm"><Clock size={15} />{duration}</span><div className="my-3 flex w-full items-center"><span className="h-px flex-1 bg-slate-300" /><Plane size={17} className="mx-2 rotate-90 text-violet-600" /><span className="h-px flex-1 bg-slate-300" /></div><span className="text-xs font-semibold">{flight.stopsLabel || "Stops unavailable"}</span></div>
        <div className="text-right"><p className="text-3xl font-bold text-slate-900">{flight.arrival || "—"}</p><p className="mt-1 font-semibold text-slate-600">{flight.to || "—"}</p><p className="text-xs text-slate-500">{flight.toName || "Airport name unavailable"}</p></div>
      </div>}

      <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-6 py-5 text-sm text-slate-600 sm:px-8">
        {flight.segments?.length > 1 && <p>Segments: {flight.segments.map((segment) => `${segment.flightNumber || segment.airline || "Flight"} (${segment.origin.code || "—"} → ${segment.destination.code || "—"})`).join(" · ")}</p>}
        <p>{flight.extensions?.length ? flight.extensions.join(" · ") : "Baggage and fare details unavailable"}</p>
        {flight.emissionsGrams != null && <p>Estimated emissions: {(flight.emissionsGrams / 1000).toLocaleString()} kg CO₂ for this itinerary</p>}
        <div className="flex flex-wrap items-end gap-3 pt-2">
          <label className="text-xs font-semibold text-slate-600">Target fare (optional)<input type="number" min="1" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder={`Below ${price}`} className="mt-1 block w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800" /></label>
          {onChooseOutbound ? <button type="button" disabled={choosingOutbound || !flight.departureRef} onClick={() => onChooseOutbound(flight)} className="rounded-xl bg-violet-700 px-5 py-2.5 font-semibold text-white hover:bg-violet-800 disabled:opacity-60">{choosingOutbound ? "Loading next options…" : chooseLabel}</button> : <><button type="button" disabled={busy || tracked} onClick={trackFlight} className="rounded-xl bg-violet-700 px-5 py-2.5 font-semibold text-white hover:bg-violet-800 disabled:opacity-60">{tracked ? "Tracking" : busy ? "Saving…" : "Track this flight"}</button>{flight.bookingRef && <button type="button" disabled={bookingBusy} onClick={loadBookingOptions} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 font-semibold text-slate-700 disabled:opacity-60">{bookingBusy ? "Loading options…" : "Booking options"}</button>}</>}
        </div>
        {bookingOptions && <div className="mt-4 grid gap-3 sm:grid-cols-2">{bookingOptions.length === 0 ? <p className="text-xs text-slate-500">No bookable provider options were returned for this flight.</p> : bookingOptions.map((option, index) => {
          const fields = option.bookingPostData ? [...new URLSearchParams(option.bookingPostData).entries()] : [];
          return <div key={`${option.provider}-${index}`} className="rounded-xl border border-slate-200 bg-white p-4"><p className="font-semibold text-slate-900">{option.provider}{option.isAirline ? " · Airline" : ""}</p><p className="mt-1 text-sm text-slate-600">{option.price == null ? "Price unavailable" : new Intl.NumberFormat("en-IN", { style: "currency", currency: option.currency || flight.currency, maximumFractionDigits: 0 }).format(option.price)}{option.fareName ? ` · ${option.fareName}` : ""}</p>{option.extensions?.length > 0 && <p className="mt-2 text-xs text-slate-500">{option.extensions.join(" · ")}</p>}{option.baggage?.length > 0 && <p className="mt-1 text-xs text-slate-500">{option.baggage.join(" · ")}</p>}{option.bookingUrl && (fields.length ? <form action={option.bookingUrl} method="post" target="_blank" rel="noreferrer" className="mt-3">{fields.map(([key, value], fieldIndex) => <input key={`${key}-${fieldIndex}`} type="hidden" name={key} value={value} />)}<button className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white">Continue to provider</button></form> : <a href={option.bookingUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white">Continue to provider</a>)}</div>;
        })}</div>}
      </div>
    </article>
  );
}

export default FlightCard;
