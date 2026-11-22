import { useState } from "react";

const cabinOptions = ["Economy", "Premium Economy", "Business", "First Class"];

function CabinSelector({ onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [cabin, setCabin] = useState("Economy");

  return (
    <div className="flex flex-col">
      <label className="text-sm font-medium text-gray-700">Cabin Class</label>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="mt-2 rounded-xl border border-gray-300 px-4 py-3 text-left"
      >
        ✈ {cabin} ▼
      </button>

      {isOpen && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
          {cabinOptions.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setCabin(option);
                onChange?.(option);
                setIsOpen(false);
              }}
              className={`w-full px-4 py-3 text-left hover:bg-violet-50 ${
                cabin === option ? "bg-violet-100 font-semibold text-violet-700" : "text-gray-700"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default CabinSelector;
