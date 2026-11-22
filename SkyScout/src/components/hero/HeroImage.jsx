import aircraft from '../../assets/images/hero-aircraft-1536.webp';
import aircraftSmall from '../../assets/images/hero-aircraft-768.webp';

export default function HeroImage() {
  return <figure className="relative min-w-0 overflow-hidden rounded-[2rem] border border-violet-100 bg-violet-50 shadow-2xl shadow-violet-900/10 sm:rounded-[2.5rem]">
    <img src={aircraft} srcSet={`${aircraftSmall} 768w, ${aircraft} 1536w`} sizes="(min-width: 1280px) 620px, (min-width: 1024px) 50vw, (min-width: 640px) 80vw, 100vw"
      width="1536" height="1024" fetchPriority="high" decoding="async" alt="Modern white passenger aircraft with a violet tail flying above sunlit clouds."
      className="aspect-[3/2] w-full object-cover" />
    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-indigo-950/70 to-transparent" />
    <figcaption className="absolute inset-x-0 bottom-0 px-5 py-5 text-white sm:px-7 sm:py-6"><p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/80">A clearer view of your journey</p><p className="mt-1 text-lg font-semibold sm:text-xl">More possibility. Less guesswork.</p></figcaption>
  </figure>;
}
