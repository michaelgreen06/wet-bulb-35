import type { Metadata } from 'next';
import Link from 'next/link';
import InhabitedHotspotDashboard from '@/components/InhabitedHotspotDashboard';

export const metadata: Metadata = {
  title: 'Inhabited Wet Bulb Forecast Hotspots',
  description:
    'Rank the highest forecast wet-bulb temperatures at populated places over the next 24 hours.',
};

export default function InhabitedHotspotsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="border-b-4 border-stone-950 bg-white px-4 py-8 md:px-0">
        <Link
          href="/"
          className="inline-flex border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700 transition hover:border-stone-950"
        >
          Back to current wet bulb
        </Link>
        <p className="mt-8 text-xs font-black uppercase tracking-[0.28em] text-orange-700">
          City forecast ranking
        </p>
        <h1 className="mt-3 max-w-4xl text-4xl font-black text-stone-950 md:text-6xl">
          Wet-bulb hotspots where people live.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
          Highest forecast wet-bulb among up to 1,000 grid-prioritized populated places
          above 25,000 people in the next 24 hours. This is not an exhaustive global ranking.
        </p>
      </section>

      <InhabitedHotspotDashboard />
    </div>
  );
}
