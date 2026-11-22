import { useRef, useState } from 'react';
import { Calendar, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Card from '../ui/Card';
import SectionTitle from '../ui/SectionTitle';
import Button from '../ui/Button';
import InputField from '../ui/InputField';
import AirportAutocomplete from './AirportAutocomplete';
import SwapButton from './swapButton';
import TravellerSelector from '../../traveller/TravellerSelector';
import CabinSelector from '../cabin/CabinSelector';
import TripTypeSelector from './TripTypeSelector';
import { airportSelection, buildFlightSearch, editedAirport, swapAirports } from '../../utils/flightSearch.js';

const emptyLeg = () => ({ from: editedAirport(''), to: editedAirport(''), date: '' });

function FlightSearchCard() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(() => editedAirport(''));
  const [to, setTo] = useState(() => editedAirport(''));
  const [departure, setDeparture] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [tripType, setTripType] = useState('one-way');
  const [multiLegs, setMultiLegs] = useState(() => [emptyLeg(), emptyLeg()]);
  const [travellers, setTravellers] = useState({ adults: 1, children: 0, infants: 0 });
  const [travelClass, setTravelClass] = useState(1);
  const [error, setError] = useState('');
  const navigating = useRef(false);

  function handleSearch() {
    if (navigating.current) return;
    const result = buildFlightSearch({ from, to, departure, returnDate, tripType, multiLegs, travellers, travelClass });
    if (result.error) { setError(result.error); return; }
    setError(''); navigating.current = true;
    navigate('/results', { state: result.data });
  }
  const changeLeg = (index, field, value) => setMultiLegs((items) => items.map((leg, i) => i === index ? { ...leg, [field]: value } : leg));
  const airportInput = (label, selection, update, wideOnMobile = false) => <AirportAutocomplete label={label} value={selection.text} selectedAirport={selection.airport} wideOnMobile={wideOnMobile}
    onChange={(text) => update(editedAirport(text))} onSelect={(airport) => update(airportSelection(airport))} />;

  return <section id="flight-search" className="bg-gradient-to-b from-violet-50 via-white to-gray-50 py-24">
    <div className="mx-auto max-w-7xl px-4 sm:px-6">
      <SectionTitle title="Search live flight fares" subtitle="Compare available schedules and prices for your route." />
      <Card className="mt-12 border-0 shadow-2xl">
        {error && <p role="alert" className="mb-6 rounded-xl bg-red-50 p-3 text-center text-red-700">{error}</p>}
        <div className="space-y-8">
          <TripTypeSelector tripType={tripType} setTripType={setTripType} />
          {tripType === 'multi-city' ? <div className="space-y-4">
            {multiLegs.map((leg, index) => <div key={`city-leg-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center justify-between"><p className="text-sm font-bold text-slate-800">Leg {index + 1}</p>{multiLegs.length > 2 && <button type="button" onClick={() => setMultiLegs((items) => items.filter((_, i) => i !== index))} className="text-sm font-semibold text-rose-600">Remove leg {index + 1}</button>}</div>
              <div className="grid gap-4 md:grid-cols-3">
                {airportInput('From', leg.from, (value) => changeLeg(index, 'from', value))}
                {airportInput('To', leg.to, (value) => changeLeg(index, 'to', value))}
                <InputDate label="Departure" value={leg.date} onChange={(date) => changeLeg(index, 'date', date)} />
              </div>
            </div>)}
            {multiLegs.length < 4 && <button type="button" onClick={() => setMultiLegs((items) => [...items, { ...emptyLeg(), from: items.at(-1).to }])} className="rounded-xl border border-violet-300 bg-white px-4 py-2.5 text-sm font-semibold text-violet-700 hover:bg-violet-50">Add another city leg</button>}
          </div> : <>
            <div className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:gap-4">
              {airportInput('From', from, setFrom, true)}
              <SwapButton onSwap={() => { const swapped = swapAirports(from, to); setFrom(swapped.from); setTo(swapped.to); }} />
              {airportInput('To', to, setTo, true)}
            </div>
            <div className="grid gap-6 sm:grid-cols-2"><InputDate label="Departure" value={departure} onChange={setDeparture} />{tripType === 'round-trip' && <InputDate label="Return" value={returnDate} onChange={setReturnDate} />}</div>
          </>}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2"><TravellerSelector onChange={setTravellers} /><CabinSelector onChange={(cabin) => setTravelClass({ Economy: 1, 'Premium Economy': 2, Business: 3, 'First Class': 4 }[cabin])} /></div>
          <Button variant="primary" onClick={handleSearch} className="flex w-full items-center justify-center gap-2 py-4 text-lg"><Search size={20} /> Search flights</Button>
        </div>
      </Card>
    </div>
  </section>;
}

function InputDate(props) { return <InputField {...props} type="date" icon={Calendar} />; }
export default FlightSearchCard;
