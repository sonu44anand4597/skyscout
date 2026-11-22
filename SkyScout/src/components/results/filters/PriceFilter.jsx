import { IndianRupee } from "lucide-react";
import FilterSection from "./FilterSection";

function PriceFilter({
  maxPrice,
  setMaxPrice,
  maxAvailablePrice = 10000,
  currency = 'INR',
}) {
  const ceiling = Math.max(1, Number(maxAvailablePrice) || 10000);
  const money = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  const percentage =
    Math.max(0, Math.min(100, maxPrice / ceiling * 100));

  return (
    <FilterSection title="Price">

      <div className="mb-5 flex items-center justify-between rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-4 text-white shadow-lg">

        <div className="flex items-center gap-2">

          <IndianRupee size={18} />

          <div>

            <p className="text-xs uppercase tracking-widest text-violet-100">
              Maximum Budget
            </p>

            <h2 className="text-2xl font-bold">
              {money(maxPrice)}
            </h2>

          </div>

        </div>

      </div>

      <div className="relative">

        <input
          type="range"
          min="0"
          max={ceiling}
          step="1"
          aria-label="Maximum fare"
          value={maxPrice}
          onChange={(e) =>
            setMaxPrice(Number(e.target.value))
          }
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-violet-600"
        />

        <div
          className="absolute -top-2 h-6 w-6 rounded-full border-4 border-white bg-violet-600 shadow-lg transition-all"
          style={{
            left: `calc(${percentage}% - 12px)`,
          }}
        />

      </div>

      <div className="mt-4 flex justify-between text-sm font-medium text-slate-500">

        <span>{money(0)}</span>

        <span>{money(ceiling)}</span>

      </div>

      <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 p-4">

        <div className="flex items-center justify-between">

          <span className="text-sm font-medium text-slate-600">
            Showing flights below
          </span>

          <span className="rounded-full bg-green-600 px-3 py-1 text-sm font-bold text-white">
            {money(maxPrice)}
          </span>

        </div>

      </div>

    </FilterSection>
  );
}

export default PriceFilter;
