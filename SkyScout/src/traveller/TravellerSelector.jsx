import { useState } from "react";
import TravellerRow from "./TravellerRow";

function TravellerSelector({ onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);

  const update = (setter, value) => {
    setter(value);
    const next = { adults, children, infants, ...(setter === setAdults ? { adults: value } : {}), ...(setter === setChildren ? { children: value } : {}), ...(setter === setInfants ? { infants: value } : {}) };
    if (next.infants > next.adults) { next.infants = next.adults; setInfants(next.infants); }
    onChange?.(next);
  };

  return (
    <div className="relative flex flex-col">
      <label className="text-sm font-medium text-gray-700">Travellers</label>
      <button type="button" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)} className="mt-2 rounded-xl border border-gray-300 px-4 py-3 text-left">
        {adults + children + infants} traveller{adults + children + infants === 1 ? "" : "s"} · {adults} adult{adults === 1 ? "" : "s"}
      </button>
      {isOpen && <div className="absolute left-0 top-full z-20 mt-2 w-full rounded-xl border border-gray-200 bg-white p-5 shadow-lg">
        <TravellerRow title="Adults" subtitle="Age 13+" count={adults} setCount={(v) => update(setAdults, v)} min={1} max={9 - children} />
        <TravellerRow title="Children" subtitle="Age 2–12" count={children} setCount={(v) => update(setChildren, v)} min={0} max={9 - adults} />
        <TravellerRow title="Infants" subtitle="Under 2 · on lap" count={infants} setCount={(v) => update(setInfants, v)} min={0} max={adults} />
        <button type="button" onClick={() => setIsOpen(false)} className="mt-4 w-full rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white">Done</button>
      </div>}
    </div>
  );
}

export default TravellerSelector;
