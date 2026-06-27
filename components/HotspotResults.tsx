'use client';

import { format } from 'date-fns';
import type { HotspotCell, HotspotSnapshot } from '@/lib/types/hotspots';
import { getGoogleMapsSearchUrl } from '@/lib/utils/hotspotGeo';

type HotspotResultsProps = {
  data: HotspotSnapshot | null;
  isLoading: boolean;
  error: string | null;
};

function formatTime(value: string): string {
  return format(new Date(value), 'MMM d, HH:mm');
}

function formatCoord(value: number, positive: string, negative: string): string {
  const suffix = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}°${suffix}`;
}

function getMostHumidHotspot(hotspots: HotspotCell[]): HotspotCell | null {
  return hotspots.reduce<HotspotCell | null>((best, hotspot) => {
    if (!best || hotspot.rhAtPeakTemp > best.rhAtPeakTemp) {
      return hotspot;
    }

    return best;
  }, null);
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-3xl border border-white/60 bg-white/75 p-5 shadow-lg shadow-orange-100/40">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-orange-700">{label}</p>
      <p className="mt-3 text-3xl font-black text-stone-950">{value}</p>
      <p className="mt-2 text-sm text-stone-600">{detail}</p>
    </div>
  );
}

function HotspotCard({ hotspot, rank }: { hotspot: HotspotCell; rank: number }) {
  const shownHotHours = hotspot.hotHours.slice(0, 6);
  const nearestLocation = hotspot.nearestLocation;

  return (
    <article className="group relative overflow-hidden rounded-[2rem] border border-stone-200 bg-white p-5 shadow-xl shadow-stone-200/60 transition hover:-translate-y-1 hover:shadow-2xl">
      <div className="absolute right-0 top-0 h-24 w-24 rounded-bl-full bg-gradient-to-bl from-orange-200 to-transparent opacity-80" />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.3em] text-stone-400">
            Hotspot {rank}
          </p>
          <h2 className="mt-2 text-2xl font-black text-stone-950">
            {formatCoord(hotspot.lat, 'N', 'S')}, {formatCoord(hotspot.lon, 'E', 'W')}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-bold">
            <a
              href={getGoogleMapsSearchUrl(hotspot.lat, hotspot.lon)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-700 underline decoration-orange-300 underline-offset-4 hover:text-orange-900"
            >
              View on map
            </a>
            {nearestLocation && (
              <a
                href={nearestLocation.url}
                className="text-stone-700 underline decoration-stone-300 underline-offset-4 hover:text-stone-950"
              >
                Nearest known location: {nearestLocation.name}, {nearestLocation.admin1},{' '}
                {nearestLocation.country} · {nearestLocation.distanceKm.toFixed(1)} km away
              </a>
            )}
          </div>
        </div>
        <div className="rounded-2xl bg-orange-100 px-3 py-2 text-right">
          <p className="text-xs font-bold text-orange-800">Peak WB</p>
          <p className="text-xl font-black text-orange-950">
            {hotspot.peakWetBulbC.toFixed(1)}°C
          </p>
        </div>
      </div>

      <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-stone-50 p-3">
          <p className="text-xs font-bold uppercase text-stone-500">Peak air</p>
          <p className="mt-1 text-xl font-black text-stone-950">
            {hotspot.peakTempC.toFixed(1)}°C
          </p>
          <p className="text-xs text-stone-500">{formatTime(hotspot.peakTempTime)}</p>
        </div>
        <div className="rounded-2xl bg-stone-50 p-3">
          <p className="text-xs font-bold uppercase text-stone-500">Humidity</p>
          <p className="mt-1 text-xl font-black text-stone-950">
            {hotspot.rhAtPeakTemp.toFixed(0)}%
          </p>
          <p className="text-xs text-stone-500">at hottest hour</p>
        </div>
        <div className="rounded-2xl bg-stone-50 p-3">
          <p className="text-xs font-bold uppercase text-stone-500">Wet bulb time</p>
          <p className="mt-1 text-lg font-black text-stone-950">
            {formatTime(hotspot.peakWetBulbTime)}
          </p>
          <p className="text-xs text-stone-500">{hotspot.hotHours.length} hot hours</p>
        </div>
      </div>

      <div className="relative mt-5">
        <p className="text-sm font-bold text-stone-700">Threshold hours</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {shownHotHours.map((hour) => (
            <span
              key={`${hour.time}-${hour.tempC}-${hour.wetBulbC}`}
              className="rounded-full bg-stone-950 px-3 py-1 text-xs font-semibold text-orange-50"
            >
              {formatTime(hour.time)} · {hour.tempC.toFixed(1)}°C · WB {hour.wetBulbC.toFixed(1)}°C
            </span>
          ))}
          {hotspot.hotHours.length > shownHotHours.length && (
            <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-900">
              +{hotspot.hotHours.length - shownHotHours.length} more
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export default function HotspotResults({ data, isLoading, error }: HotspotResultsProps) {
  if (isLoading && data == null) {
    return (
      <div className="rounded-[2rem] border border-orange-200 bg-white/80 p-8 text-center shadow-xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-orange-200 border-t-orange-700" />
        <p className="mt-4 font-semibold text-stone-700">Loading latest hotspot snapshot...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[2rem] border border-red-200 bg-red-50 p-6 text-red-800 shadow-xl">
        <p className="font-bold">Forecast scan failed</p>
        <p className="mt-2 text-sm">{error}</p>
      </div>
    );
  }

  if (data == null) {
    return null;
  }

  const hottest = data.hotspots[0] ?? null;
  const highestWetBulb = [...data.hotspots].sort(
    (a, b) => b.peakWetBulbC - a.peakWetBulbC,
  )[0] ?? null;
  const mostHumid = getMostHumidHotspot(data.hotspots);

  return (
    <section className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard
          label="Hotspots"
          value={String(data.hotspots.length)}
          detail={`${data.scan.pointsScanned.toLocaleString()} points scanned`}
        />
        <SummaryCard
          label="Hottest air"
          value={hottest ? `${hottest.peakTempC.toFixed(1)}°C` : 'None'}
          detail={hottest ? `${hottest.lat.toFixed(1)}, ${hottest.lon.toFixed(1)}` : 'No cells above threshold'}
        />
        <SummaryCard
          label="Highest WB"
          value={highestWetBulb ? `${highestWetBulb.peakWetBulbC.toFixed(1)}°C` : 'None'}
          detail={highestWetBulb ? formatTime(highestWetBulb.peakWetBulbTime) : 'No wet-bulb hotspot'}
        />
        <SummaryCard
          label="Most humid"
          value={mostHumid ? `${mostHumid.rhAtPeakTemp.toFixed(0)}%` : 'None'}
          detail={mostHumid ? `${mostHumid.lat.toFixed(1)}, ${mostHumid.lon.toFixed(1)}` : 'No humid hotspot'}
        />
      </div>

      <div className="rounded-3xl border border-stone-200 bg-stone-950 p-4 text-sm text-orange-50 shadow-xl">
        <span className="font-bold">{data.region.label}</span> · {data.scan.forecastHours}h ·{' '}
        {data.scan.batchCount} Open-Meteo batches · generated {formatTime(data.scan.generatedAt)}
        {data.scan.cacheHit ? ' · cache hit' : ''}
      </div>

      {data.hotspots.length === 0 ? (
        <div className="rounded-[2rem] border border-stone-200 bg-white p-8 text-center text-stone-700 shadow-xl">
          No forecast cells crossed the selected thresholds. Lower threshold, find hidden desert beast.
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.hotspots.map((hotspot, index) => (
            <HotspotCard
              key={`${hotspot.lat}-${hotspot.lon}-${hotspot.peakWetBulbTime}`}
              hotspot={hotspot}
              rank={index + 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}
