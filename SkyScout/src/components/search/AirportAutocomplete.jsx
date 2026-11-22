import { useState, useEffect, useRef, useId } from 'react';
import { MapPin } from 'lucide-react';
import InputField from '../ui/InputField';
import { apiRequest } from '../../api/client.js';

function AirportAutocomplete({ label, value, onChange, selectedAirport = null, onSelect, wideOnMobile = false }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [result, setResult] = useState({ query: '', airports: [], message: '', loading: false });
  const wrapperRef = useRef(null);
  const inputId = useId().replaceAll(':', '');
  const listboxId = `${inputId}-airports`;
  const query = value.trim();
  const current = result.query === query;
  const airports = current ? result.airports : [];
  const searching = query.length >= 2 && (!current || result.loading);

  useEffect(() => {
    if (!showDropdown || selectedAirport || query.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResult({ query, airports: [], message: '', loading: true });
      try {
        const response = await apiRequest(`/flights/airports?q=${encodeURIComponent(query)}`, { signal: controller.signal, timeoutMs: 30000 });
        if (!Array.isArray(response.data) || response.data.some((airport) => !/^[A-Z]{3}$/.test(airport?.iata || airport?.code || '') || !airport.city || !airport.airport)) throw new Error('Airport search returned an invalid response. Please try again.');
        if (controller.signal.aborted) return;
        setResult({ query, airports: response.data, message: response.airportSearch?.message || '', loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query, airports: [], message: error.message || 'Airport search is having trouble. Please try again.', loading: false });
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, selectedAirport, showDropdown]);

  useEffect(() => {
    const outside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) { setShowDropdown(false); setSelectedIndex(-1); }
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, []);

  function select(airport) {
    if (!airport) return;
    onSelect?.(airport);
    setShowDropdown(false); setSelectedIndex(-1);
  }

  return <div ref={wrapperRef} className={`min-w-0 ${wideOnMobile ? 'sm:relative' : 'relative'}`}>
    <InputField label={label} type="text" placeholder="Search city or airport..." value={value} id={inputId} role="combobox"
      ariaAutocomplete="list" ariaExpanded={showDropdown} ariaControls={showDropdown ? listboxId : undefined}
      ariaActiveDescendant={showDropdown && selectedIndex >= 0 && selectedIndex < airports.length ? `${listboxId}-option-${selectedIndex}` : undefined}
      icon={MapPin} autoComplete="off" onFocus={() => setShowDropdown(!selectedAirport)}
      onBlur={() => { setShowDropdown(false); setSelectedIndex(-1); }}
      onChange={(text) => { onChange(text); setShowDropdown(true); setSelectedIndex(-1); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); setShowDropdown(false); setSelectedIndex(-1); }
        if (selectedAirport) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setShowDropdown(true);
          setSelectedIndex((index) => airports.length ? event.key === 'ArrowDown' ? Math.min(index + 1, airports.length - 1) : Math.max(index - 1, 0) : -1);
        }
        if (event.key === 'Enter' && showDropdown && airports[selectedIndex]) { event.preventDefault(); select(airports[selectedIndex]); }
      }} />
    {showDropdown && <div id={listboxId} role="listbox" aria-label={`${label || 'Airport'} suggestions`} className="absolute left-0 top-full z-50 mt-2 max-h-80 w-full overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-xl">
      {query.length < 2 ? <div className="p-5 text-center text-gray-500">Type a city, airport, or IATA code.</div>
        : searching ? <div role="status" className="p-5 text-center text-gray-500">Finding airports…</div>
          : <>{result.message && <div role="status" className="px-4 py-3 text-xs text-gray-500">{result.message}</div>}
            {airports.map((airport, index) => <div id={`${listboxId}-option-${index}`} key={airport.iata || airport.code} role="option" aria-selected={selectedIndex === index}
              onMouseDown={(event) => event.preventDefault()} onClick={() => select(airport)}
              className={`cursor-pointer p-4 transition ${selectedIndex === index ? 'bg-violet-100' : 'hover:bg-violet-50'}`}>
              <div className="flex gap-4"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600"><MapPin size={18} /></div>
                <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><h3 className="min-w-0 break-words font-semibold">{airport.city}</h3><span className="shrink-0 rounded-lg bg-gray-100 px-2 py-1 text-xs font-semibold">{airport.iata || airport.code}</span></div><p className="mt-1 break-words text-sm text-gray-500">{airport.airport}</p></div>
              </div>
            </div>)}
            {!airports.length && !result.message && <div role="status" className="p-5 text-center text-gray-500">No matching airports found.</div>}
          </>}
    </div>}
  </div>;
}
export default AirportAutocomplete;
