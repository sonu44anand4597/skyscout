import FilterSection from "./FilterSection";


function StopsFilter({
  selectedStop,
  setSelectedStop,
}) {
  const options = [
    "All",
    "Non-stop",
    "1 Stop",
    "2+ Stops",
  ];

  return (
    <FilterSection title="Stops">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        
      </h3>

      <div className="space-y-4">
        {options.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-3"
          >
            <input
              type="radio"
              name="stops"
              checked={selectedStop === option}
              onChange={() => setSelectedStop(option)}
              className="h-4 w-4 accent-violet-600"
            />

            <span className="text-gray-700">
              {option}
            </span>
          </label>
        ))}
      </div>
    </FilterSection>
  );
}

export default StopsFilter;
