import {
  Plane,
  IndianRupee,
  Clock3,
  Filter,
  RotateCcw,
} from "lucide-react";

import StopsFilter from "./filters/StopsFilter";
import PriceFilter from "./filters/PriceFilter";

function FilterSidebar({
  selectedStop,
  setSelectedStop,
  maxPrice,
  setMaxPrice,
  selectedAirlines,
  setSelectedAirlines,
  availableAirlines = [],
  departureTime,
  setDepartureTime,
  clearFilters,
  maxAvailablePrice,
  currency,
  maxDuration = 0,
  setMaxDuration,
}) {
  return (
    <aside className="sticky top-24 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-600 to-indigo-600 p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Filter size={22} />
            <h2 className="text-xl font-bold">
              Filters
            </h2>
          </div>

          <button
            onClick={clearFilters}
            className="flex items-center gap-2 rounded-xl bg-white/20 px-3 py-2 text-sm font-medium transition hover:bg-white/30"
          >
            <RotateCcw size={16} />
            Reset
          </button>
        </div>

        <p className="mt-2 text-sm text-violet-100">
          Refine your perfect flight.
        </p>
      </div>

      <div className="space-y-8 p-6">
        {/* Stops */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Plane
              size={18}
              className="text-violet-600"
            />
            <h3 className="font-semibold text-slate-800">
              Stops
            </h3>
          </div>

          <StopsFilter
            selectedStop={selectedStop}
            setSelectedStop={setSelectedStop}
          />
        </div>

        {/* Price */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="mb-4 flex items-center gap-2">
            <IndianRupee
              size={18}
              className="text-green-600"
            />
            <h3 className="font-semibold text-slate-800">
              Maximum Budget
            </h3>
          </div>

          <PriceFilter
            maxPrice={maxPrice}
            setMaxPrice={setMaxPrice}
            maxAvailablePrice={maxAvailablePrice}
            currency={currency}
          />

          <div className="mt-4 rounded-xl bg-green-50 py-3 text-center">
            <span className="text-lg font-bold text-green-700">
              {new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(maxPrice)}
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <label htmlFor="max-flight-duration" className="mb-3 block font-semibold text-slate-800">Flight duration</label>
          <select id="max-flight-duration" value={maxDuration} onChange={(event) => setMaxDuration(Number(event.target.value))} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-700">
            <option value="0">Any duration</option>
            {[2, 4, 8, 12, 24].map((hours) => <option key={hours} value={hours * 60}>Up to {hours} hours</option>)}
          </select>
        </div>
        {/* Airlines */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <h3 className="mb-4 font-semibold text-slate-800">
            Airlines
          </h3>

          <div className="max-h-56 space-y-3 overflow-y-auto pr-2">
            {availableAirlines.length > 0 ? (
              availableAirlines.map((airline) => (
                <label
                  key={airline}
                  className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-violet-300 hover:bg-violet-50"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selectedAirlines.includes(
                        airline
                      )}
                      onChange={() => {
                        if (
                          selectedAirlines.includes(
                            airline
                          )
                        ) {
                          setSelectedAirlines(
                            selectedAirlines.filter(
                              (item) =>
                                item !== airline
                            )
                          );
                        } else {
                          setSelectedAirlines([
                            ...selectedAirlines,
                            airline,
                          ]);
                        }
                      }}
                      className="h-4 w-4 accent-violet-600"
                    />

                    <span className="font-medium text-slate-700">
                      {airline}
                    </span>
                  </div>
                </label>
              ))
            ) : (
              <p className="text-sm text-slate-500">
                Airlines will appear after your
                first search.
              </p>
            )}
          </div>
        </div>

        {/* Departure */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Clock3
              size={18}
              className="text-orange-500"
            />
            <h3 className="font-semibold text-slate-800">
              Departure Time
            </h3>
          </div>

          <div className="space-y-3">
            {[
              "All",
              "Morning",
              "Afternoon",
              "Evening",
              "Night",
            ].map((time) => (
              <label
                key={time}
                className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition ${
                  departureTime === time
                    ? "border-violet-500 bg-violet-50"
                    : "border-slate-200 bg-white hover:border-violet-300"
                }`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="departure-time"
                    checked={
                      departureTime === time
                    }
                    onChange={() =>
                      setDepartureTime(time)
                    }
                    className="accent-violet-600"
                  />

                  <span className="font-medium">
                    {time}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

export default FilterSidebar;
