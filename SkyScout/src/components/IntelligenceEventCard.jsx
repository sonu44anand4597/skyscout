import { CalendarDays, CloudRain, Fuel, Landmark, MapPin, Music2, Plane, Route, Ticket, Users } from "lucide-react";

const ICONS = { holiday: CalendarDays, festival: Landmark, airline: Plane, airport: Plane, weather: CloudRain, road: Route, strike: Users, concert: Music2, sport: Ticket, fuel: Fuel, other: MapPin };
const PRESSURE = { upward: "Possible upward", downward: "Possible downward", mixed: "Mixed", uncertain: "Uncertain" };

export default function IntelligenceEventCard({ event, destination = false }) {
  const Icon = ICONS[event.category] || MapPin;
  const date = event.eventStart ? new Date(`${event.eventStart}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Date unverified";
  const status = destination ? event.routeImpactStatus === "possibly_affected" ? "Possible route overlap" : "Route impact unverified" : event.evidenceStatus === "verified" ? "Verified event" : "Source-backed, impact unverified";
  return <article className="min-w-0 [overflow-wrap:anywhere] rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label={event.title}>
    <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-500"><span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 capitalize text-slate-700"><Icon size={13} />{event.category}</span><span>{date}</span><span>·</span><span>{event.location || "Location unspecified"}</span></div>
    <h4 className="mt-3 text-sm font-bold leading-5 text-slate-900">{event.title}</h4>
    <p className="mt-1 text-[11px] text-slate-500">{event.relevance?.level || 'RELATED'} · Published {event.publishedAt || 'date unverified'}</p>
    <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-700">{event.summary}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2"><span className="rounded-full border border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-700">{destination ? status : PRESSURE[event.impactDirection] || PRESSURE.uncertain}</span><span className="text-[11px] text-slate-500">{destination ? event.affectedRoads?.join(", ") || "Road unspecified" : status}</span></div>
    <p className="mt-3 text-xs leading-5 text-slate-600">{event.relevance?.reason} {event.impactExplanation}</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px]"><a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-700 underline">{event.sourceTitle || "Grounded source"}</a><span className="text-slate-500">Researched {event.researchedAt ? new Date(event.researchedAt).toLocaleString("en-IN") : "time unavailable"}</span></div>
  </article>;
}
