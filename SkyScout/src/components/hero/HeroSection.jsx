import { ArrowDown, ArrowUpRight } from 'lucide-react';
import HeroFeatures from './HeroFeatures.jsx';
import HeroImage from './HeroImage.jsx';

export default function HeroSection() {
  return <section aria-labelledby="hero-title" className="relative px-5 py-12 sm:px-8 sm:py-16 lg:px-12 lg:py-20">
    <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-12">
      <div className="min-w-0">
        <p className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3.5 py-2 text-xs font-semibold text-violet-700 sm:text-sm"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-violet-500" />Live flight search</p>
        <h1 id="hero-title" className="mt-6 text-4xl font-extrabold leading-[1.12] tracking-tight text-slate-900 sm:text-5xl xl:text-6xl">Find the flight<br />that fits your<br /><span className="text-violet-600">next trip.</span></h1>
        <p className="mt-6 max-w-lg text-base leading-7 text-slate-600 sm:text-lg">Compare current flight schedules and fares for your route in one clear view. Save your itinerary and keep an eye on the price.</p>
        <div className="mt-7 flex flex-wrap items-center gap-5">
          <a href="#flight-search" className="inline-flex items-center gap-3 rounded-xl bg-violet-700 px-5 py-3.5 font-semibold text-white shadow-lg shadow-violet-700/15 transition hover:bg-violet-800">Search flights<ArrowUpRight size={18} aria-hidden="true" /></a>
          <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-500"><ArrowDown size={15} aria-hidden="true" />Your journey starts below</span>
        </div>
        <HeroFeatures />
      </div>
      <HeroImage />
    </div>
  </section>;
}
