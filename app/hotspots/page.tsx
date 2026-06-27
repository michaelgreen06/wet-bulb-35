import type { Metadata } from 'next';
import Link from 'next/link';
import HotspotDashboard from '@/components/HotspotDashboard';

export const metadata: Metadata = {
  title: 'Global Wet Bulb Forecast Hotspots',
  description: 'Browse the latest generated forecast cells for high heat and wet-bulb conditions over the next 24 hours.',
};

export default function HotspotsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="relative overflow-hidden rounded-[2.5rem] bg-[radial-gradient(circle_at_top_left,#fed7aa,transparent_32%),linear-gradient(135deg,#fff7ed,#fef3c7_42%,#f5f5f4)] p-8 shadow-2xl shadow-orange-100 md:p-12">
        <div className="absolute -right-10 -top-10 h-48 w-48 rounded-full border-[32px] border-orange-200/60" />
        <div className="absolute bottom-6 right-8 hidden h-20 w-40 rotate-[-8deg] rounded-full bg-stone-950/90 md:block" />
        <div className="relative max-w-3xl">
          <Link
            href="/"
            className="inline-flex rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-sm font-bold text-stone-700 transition hover:bg-white"
          >
            Back to current weather
          </Link>
          <p className="mt-8 text-sm font-black uppercase tracking-[0.35em] text-orange-700">
            Daily forecast snapshot
          </p>
          <h1 className="mt-4 text-4xl font-black tracking-tight text-stone-950 md:text-6xl">
            Find tomorrow&apos;s wet-bulb danger zones before they boil.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-stone-700">
            This page reads the latest generated global forecast snapshot, then lets
            visitors sort and filter the strongest wet-bulb heat stress hotspots without
            triggering new Open-Meteo scans.
          </p>
        </div>
      </section>

      <HotspotDashboard />
    </div>
  );
}
