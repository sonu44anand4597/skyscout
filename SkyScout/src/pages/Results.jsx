import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import FlightCard from "../components/results/FlightCard";
import FilterSidebar from "../components/results/FilterSidebar";
import { searchFlights } from "../api/flightApi";
import { apiRequest } from "../api/client.js";
import ResultsNavigation from '../components/results/ResultsNavigation.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { resultsCache, resultsViewKey } from '../utils/resultsCache.js';
import { dashboardPath } from '../utils/navigation.js';

function Results() {
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();

  const searchData = location.state;
  const cacheKey = resultsViewKey(user?.id, location.key, searchData);

  const [allFlights, setAllFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedStop, setSelectedStop] = useState("All");
  const [selectedSort, setSelectedSort] = useState("Cheapest");
  const [maxPrice, setMaxPrice] = useState(10000);
  const [maxDuration, setMaxDuration] = useState(0);
  const [selectedAirlines, setSelectedAirlines] = useState([]);
  const [departureTime, setDepartureTime] = useState("All");
  const [visibleCount, setVisibleCount] = useState(8);
  const [searchStage, setSearchStage] = useState("outbound");
  const [selectedOutbound, setSelectedOutbound] = useState(null);
  const [returnLoading, setReturnLoading] = useState(false);
  const [multiCityComplete, setMultiCityComplete] = useState(false);
  const [multiCityLegIndex, setMultiCityLegIndex] = useState(1);
  const [multiCitySelectedLegs, setMultiCitySelectedLegs] = useState([]);
  const [retryVersion, setRetryVersion] = useState(0);
  const [searchedAt, setSearchedAt] = useState(null);
  const [trackedFlightIds, setTrackedFlightIds] = useState({});
  const [lastTrackedFlightId, setLastTrackedFlightId] = useState(null);
  const [quoteNow, setQuoteNow] = useState(Date.now);
  const [loadedCacheKey, setLoadedCacheKey] = useState(null);
  const requestVersion = useRef(0);
  const requestController = useRef(null);
  const continuationBusy = useRef(false);
  useEffect(() => () => requestController.current?.abort(), []);
  useEffect(() => { const timer = setInterval(() => setQuoteNow(Date.now()), 60000); return () => clearInterval(timer); }, []);

  const airlineOptions = useMemo(
    () =>
      Array.from(
        new Set(allFlights.map((flight) => flight.airline).filter(Boolean))
      ).sort(),
    [allFlights]
  );

  const maxFlightPrice = useMemo(
    () => Math.max(...allFlights.map((flight) => Number(flight.price) || 0), 0),
    [allFlights]
  );

  useEffect(() => {
    if (authLoading) return undefined;
    const version = ++requestVersion.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    continuationBusy.current = false;
    async function loadFlights() {
      try {
        const saved = retryVersion === 0 ? resultsCache.read(cacheKey) : null;
        setLoadedCacheKey(null);
        if (saved && !saved.errorMessage) {
          setAllFlights(saved.allFlights); setSearchedAt(saved.searchedAt); setErrorMessage(saved.errorMessage);
          setSelectedStop(saved.selectedStop); setSelectedSort(saved.selectedSort); setMaxPrice(saved.maxPrice); setMaxDuration(saved.maxDuration || 0);
          setSelectedAirlines(saved.selectedAirlines); setDepartureTime(saved.departureTime); setVisibleCount(saved.visibleCount);
          setSearchStage(saved.searchStage); setSelectedOutbound(saved.selectedOutbound); setMultiCityComplete(saved.multiCityComplete);
          setMultiCityLegIndex(saved.multiCityLegIndex); setMultiCitySelectedLegs(saved.multiCitySelectedLegs);
          setTrackedFlightIds(saved.trackedFlightIds); setLastTrackedFlightId(saved.lastTrackedFlightId);
          setLoadedCacheKey(cacheKey);
          return;
        }
        setLoading(true);
        setErrorMessage("");

        if (!searchData) throw new Error("Start a flight search to see current fares.");
        const result = await searchFlights({
          origin: searchData.origin,
          destination: searchData.destination,
          departure: searchData.departure,
          returnDate: searchData.returnDate,
          tripType: searchData.tripType,
          legs: searchData.legs,
          adults: searchData.adults,
          children: searchData.children,
          infants: searchData.infants,
          travelClass: searchData.travelClass,
          currency: searchData.currency,
        }, { signal: controller.signal });

        if (controller.signal.aborted || version !== requestVersion.current) return;

        if (!Array.isArray(result.data)) {
          throw new Error("Unexpected response from flight API.");
        }

        setAllFlights(result.data);
        setTrackedFlightIds({}); setLastTrackedFlightId(null);
        setSearchedAt(result.searchedAt);
        setSearchStage('outbound'); setSelectedOutbound(null); setMultiCityComplete(false); setMultiCityLegIndex(1); setMultiCitySelectedLegs([]); setReturnLoading(false);
        setSelectedStop('All'); setSelectedAirlines([]); setDepartureTime('All'); setVisibleCount(8); setMaxDuration(0);
        if (result.data.length > 0) {
          setMaxPrice(
            Math.max(...result.data.map((flight) => Number(flight.price) || 0), 0) || 10000
          );
        }
        setLoadedCacheKey(cacheKey);
      } catch (error) {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        console.error(error);
        setErrorMessage(error.message || "Unable to load flights. Please try again.");
        setLoadedCacheKey(cacheKey);
      } finally {
        if (!controller.signal.aborted && version === requestVersion.current) setLoading(false);
      }
    }

    loadFlights();
    return () => controller.abort();
  }, [searchData, retryVersion, cacheKey, authLoading]);

  useEffect(() => {
    if (loading || returnLoading || authLoading || loadedCacheKey !== cacheKey) return;
    resultsCache.write(cacheKey, { allFlights, searchedAt, errorMessage, selectedStop, selectedSort, maxPrice, maxDuration, selectedAirlines,
      departureTime, visibleCount, searchStage, selectedOutbound, multiCityComplete, multiCityLegIndex, multiCitySelectedLegs,
      trackedFlightIds, lastTrackedFlightId });
  }, [cacheKey, loadedCacheKey, loading, returnLoading, authLoading, allFlights, searchedAt, errorMessage, selectedStop, selectedSort, maxPrice, maxDuration,
    selectedAirlines, departureTime, visibleCount, searchStage, selectedOutbound, multiCityComplete, multiCityLegIndex,
    multiCitySelectedLegs, trackedFlightIds, lastTrackedFlightId]);

  const clearFilters = () => {
    setSelectedStop("All");
    setSelectedAirlines([]);
    setSelectedSort("Cheapest");
    setDepartureTime("All");
    setVisibleCount(8);
    setMaxPrice(maxFlightPrice || 10000);
    setMaxDuration(0);
  };

  async function chooseOutbound(flight) {
    if (continuationBusy.current) return;
    continuationBusy.current = true;
    const version = ++requestVersion.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setSelectedOutbound(flight);
    setReturnLoading(true);
    setErrorMessage("");
    try {
      const response = await apiRequest(`/flights/return-options/${flight.departureRef}`, { method: "POST", signal: controller.signal, timeoutMs: 45000 });
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (!Array.isArray(response.data)) throw new Error('Unexpected response from flight API.');
      setAllFlights(response.data);
      if (response.data[0]?.quoteObservedAt) setSearchedAt(response.data[0].quoteObservedAt);
      if (searchData.tripType === "multi-city") {
        const complete = Boolean(response.data[0]?.multiCityComplete);
        setMultiCitySelectedLegs(response.data[0]?.journeyLegs?.slice(0, complete ? undefined : -1) || []);
        setMultiCityComplete(complete);
        if (!complete) setMultiCityLegIndex((index) => index + 1);
        else setSearchStage("complete");
      } else setSearchStage("return");
      setVisibleCount(8);
      setMaxDuration(0);
      setMaxPrice(Math.max(...response.data.map((item) => Number(item.price) || 0), 0) || 10000);
    } catch (error) { if (!controller.signal.aborted && version === requestVersion.current) setErrorMessage(error.message || "Unable to load return flights."); }
    finally { if (version === requestVersion.current) { continuationBusy.current = false; setReturnLoading(false); } }
  }

  const getDeparturePeriod = (time) => {
    const parts = String(time || "").split(":");
    const hour = Number(parts[0] || 0);

    if (hour >= 6 && hour < 12) return "Morning";
    if (hour >= 12 && hour < 18) return "Afternoon";
    if (hour >= 18 && hour < 24) return "Evening";
    return "Night";
  };

  const filteredFlights = useMemo(() => {
    return allFlights.filter((flight) => {
      const matchesStop = selectedStop === "All" || (selectedStop === "2+ Stops" ? flight.stops >= 2 : flight.stopsLabel === selectedStop);
      const matchesPrice = Number(flight.price) <= maxPrice;
      const matchesAirline =
        selectedAirlines.length === 0 || selectedAirlines.includes(flight.airline);
      const matchesDeparture =
        departureTime === "All" || getDeparturePeriod(flight.departure) === departureTime;

      const matchesDuration = !maxDuration || (Number.isFinite(flight.durationMinutes) && flight.durationMinutes <= maxDuration);
      return matchesStop && matchesPrice && matchesAirline && matchesDeparture && matchesDuration;
    });
  }, [allFlights, selectedStop, selectedAirlines, maxPrice, departureTime, maxDuration]);

  const sortedFlights = useMemo(() => {
    const flights = [...filteredFlights];

    if (selectedSort === "Cheapest") {
      flights.sort((a, b) => Number(a.price) - Number(b.price));
    }

    if (selectedSort === "Fastest") {
      flights.sort((a, b) => (a.durationMinutes ?? Infinity) - (b.durationMinutes ?? Infinity));
    }

    return flights;
  }, [filteredFlights, selectedSort]);

  const visibleFlights = sortedFlights.slice(0, visibleCount);
  const hasMoreFlights = visibleCount < sortedFlights.length;

  if (loading) {
    return (
      <><div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8"><ResultsNavigation dashboardPath={dashboardPath(lastTrackedFlightId)} /></div>
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-16">
        <div className="w-full max-w-4xl space-y-4 rounded-4xl border border-slate-200 bg-white p-10 shadow-xl">
          <div className="h-6 w-72 max-w-full animate-pulse rounded-full bg-slate-200" />
          <div className="grid gap-6 lg:grid-cols-2">
            {[...Array(3)].map((_, index) => (
              <div key={index} className="space-y-4 rounded-3xl bg-slate-100 p-6 shadow-sm">
                <div className="h-6 w-40 animate-pulse rounded-full bg-slate-200" />
                <div className="space-y-3">
                  <div className="h-4 w-full animate-pulse rounded-full bg-slate-200" />
                  <div className="h-4 w-5/6 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-12 w-full animate-pulse rounded-2xl bg-slate-200" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div></>
    );
  }

  if (errorMessage) {
    return (
      <><div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8"><ResultsNavigation dashboardPath={dashboardPath(lastTrackedFlightId)} /></div>
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-16">
        <div role="alert" className="max-w-xl rounded-4xl border border-red-200 bg-white p-10 text-center shadow-xl">
          <h2 className="text-3xl font-bold text-red-600">{errorMessage}</h2>
          <p className="mt-4 text-slate-600">
            Unable to load flight results. Please refresh or try a different search.
          </p>
          <a href="/#flight-search" className="mt-6 inline-flex rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white">Back to flight search</a>
          {searchData && <button type="button" onClick={() => setRetryVersion((version) => version + 1)} className="ml-3 mt-4 rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700">Retry search</button>}
        </div>
      </div></>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <ResultsNavigation dashboardPath={dashboardPath(lastTrackedFlightId)} />
      <section className="mb-8 rounded-4xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs text-slate-500">{searchedAt ? `Provider quote observed ${new Date(searchedAt).toLocaleString()}` : "Quote timestamp unavailable"}</p><p className="text-sm font-medium uppercase tracking-[0.3em] text-violet-600">
              Flight search results
            </p>
            <h1 className="mt-3 text-4xl font-semibold text-slate-900 sm:text-5xl">
              {searchData.origin} → {searchData.destination}
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              {searchData.tripType === "multi-city" ? (multiCityComplete ? "Your complete multi-city combinations are ready." : `Choose an option for city leg ${multiCityLegIndex} of ${searchData.legs.length}.`) : searchStage === "outbound" ? `Showing ${sortedFlights.length} outbound option${sortedFlights.length !== 1 ? "s" : ""} for ${searchData.departure}.` : `Choose a return itinerary for ${searchData.returnDate}.`} Use filters to narrow down by stops, airlines, departure time, or budget.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:auto-cols-max lg:grid-flow-col">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-700">
              {searchData.tripType === "round-trip" ? "Round trip" : searchData.tripType === "multi-city" ? `${searchData.legs.length}-leg itinerary` : "One-way"}
              {searchData.tripType === "round-trip" && <span className="ml-2">{searchStage === "outbound" ? "· Choose outbound" : "· Choose return"}</span>}
            </div>
          </div>
        </div>
        {selectedOutbound && !allFlights.length && !returnLoading && <button type="button" onClick={() => setRetryVersion((version) => version + 1)} className="mt-4 rounded-xl border border-violet-300 bg-violet-50 px-4 py-3 text-sm font-semibold text-violet-800">{searchData.tripType === 'multi-city' ? 'Restart itinerary selection' : 'Choose a different outbound'}</button>}
        {searchedAt && quoteNow - Date.parse(searchedAt) > 5 * 60000 && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">These saved fares are more than five minutes old. Prices and availability may have changed.</p>}
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-6">
          <FilterSidebar
            selectedStop={selectedStop}
            setSelectedStop={setSelectedStop}
            maxPrice={maxPrice}
            setMaxPrice={setMaxPrice}
            selectedAirlines={selectedAirlines}
            setSelectedAirlines={setSelectedAirlines}
            availableAirlines={airlineOptions}
            departureTime={departureTime}
            setDepartureTime={setDepartureTime}
            clearFilters={clearFilters}
            maxAvailablePrice={maxFlightPrice}
            currency={allFlights[0]?.currency || searchData.currency || 'INR'}
            maxDuration={maxDuration}
            setMaxDuration={setMaxDuration}
          />

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Filter summary</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-600">
              <li>Stops: {selectedStop}</li>
              <li>Budget: up to {new Intl.NumberFormat('en-IN', { style: 'currency', currency: allFlights[0]?.currency || searchData.currency || 'INR', maximumFractionDigits: 0 }).format(maxPrice)}</li>
              <li>Airlines: {selectedAirlines.length ? selectedAirlines.join(", ") : "Any"}</li>
              <li>Departure: {departureTime}</li>
              <li>Duration: {maxDuration ? `up to ${maxDuration / 60} hours` : 'Any'}</li>
            </ul>
          </div>
        </aside>

        <section className="min-w-0 space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Sort by</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {[
                    { label: "Cheapest", value: "Cheapest" },
                    { label: "Fastest", value: "Fastest" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setSelectedSort(option.value)}
                      className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
                        selectedSort === option.value
                          ? "bg-violet-600 text-white shadow"
                          : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-6 py-4 text-sm text-slate-600">
                Showing {visibleFlights.length} of {sortedFlights.length} flights
              </div>
            </div>
          </div>

          {returnLoading ? <div className="rounded-3xl border border-violet-100 bg-white p-10 text-center text-slate-600">Loading return combinations…</div> : sortedFlights.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-sm">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-violet-100 text-4xl text-violet-600">
                ✈️
              </div>
              <h2 className="mt-6 text-2xl font-semibold text-slate-900">{allFlights.length ? 'No flights match your filters' : 'No flights found for the selected route and dates.'}</h2>
              <p className="mt-3 text-slate-500">{allFlights.length ? 'Try resetting your filters or choosing a broader budget.' : 'Try another date or route.'}</p>
            </div>
          ) : (
            <div className="space-y-6">
              {searchStage === "return" && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4 text-sm text-violet-900"><span>Outbound selected: {selectedOutbound?.airline || "Airline"} {selectedOutbound?.flightNumber || ""}, {selectedOutbound?.departure || ""} → {selectedOutbound?.arrival || ""}</span><button type="button" onClick={() => setRetryVersion((version) => version + 1)} className="font-semibold underline">Choose a different outbound</button></div>}
              {searchData.tripType === "multi-city" && !multiCityComplete && multiCityLegIndex > 1 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4 text-sm text-violet-900"><div><span>{multiCityLegIndex - 1} of {searchData.legs.length} city legs selected.</span><div className="mt-1">{multiCitySelectedLegs.map((leg) => `Leg ${leg.legNumber}: ${leg.from} → ${leg.to} · ${leg.flightNumber || leg.airline || "Flight selected"}`).join(" | ")}</div></div><button type="button" onClick={() => setRetryVersion((version) => version + 1)} className="font-semibold underline">Restart itinerary selection</button></div>}
              {visibleFlights.map((flight) => (
                <FlightCard key={flight.id} flight={flight} searchData={searchData} initialTracked={Boolean(trackedFlightIds[flight.id])} onTracked={(offerId, savedId) => { setTrackedFlightIds((previous) => ({ ...previous, [offerId]: savedId })); setLastTrackedFlightId(savedId); }} onChooseOutbound={(searchData.tripType === "round-trip" && searchStage === "outbound") || (searchData.tripType === "multi-city" && !multiCityComplete) ? chooseOutbound : null} chooseLabel={searchData.tripType === "multi-city" ? `Choose city leg ${multiCityLegIndex}` : "Choose outbound"} farePreviewLabel={searchData.tripType === "multi-city" ? "Selected leg fare preview" : "Outbound fare preview"} choosingOutbound={returnLoading} />
              ))}
            </div>
          )}

          {hasMoreFlights && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + 8)}
                className="rounded-full bg-violet-600 px-8 py-3 text-sm font-semibold text-white transition hover:bg-violet-700"
              >
                Load more flights
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default Results;
