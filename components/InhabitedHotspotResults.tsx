'use client';

import { format } from 'date-fns';
import type { InhabitedHotspotCell, InhabitedHotspotSnapshot } from '@/lib/types/hotspots';
import { getGoogleMapsSearchUrl } from '@/lib/utils/hotspotGeo';

type InhabitedHotspotResultsProps = {
  data: InhabitedHotspotSnapshot | null;
  dataSource: string | null;
  isLoading: boolean;
  error: string | null;
};

function formatTime(value: string): string {
  return format(new Date(value), 'MMM d, HH:mm');
}

function formatPopulation(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: value >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function placeLabel(hotspot: InhabitedHotspotCell): string {
  const region = hotspot.city.admin1 || hotspot.city.admin1Code;
  const country = hotspot.city.country || hotspot.city.countryCode;

  return [hotspot.city.name, region, country].filter(Boolean).join(', ');
}

function WetBulbBadge({ value }: { value: number }) {
  const tone =
    value >= 35
      ? 'bg-red-950 text-red-50'
      : value >= 32
        ? 'bg-orange-700 text-white'
        : 'bg-amber-300 text-stone-950';

  return (
    <span className={`inline-flex min-w-20 justify-center rounded-md px-3 py-1.5 text-sm font-black ${tone}`}>
      {value.toFixed(1)}°C
    </span>
  );
}

function RankRow({ hotspot, rank }: { hotspot: InhabitedHotspotCell; rank: number }) {
  return (
    <tr className="border-b border-stone-200 bg-white transition hover:bg-amber-50/70">
      <td className="w-16 px-4 py-4 text-center text-lg font-black text-stone-950">{rank}</td>
      <td className="px-4 py-4">
        <a
          href={getGoogleMapsSearchUrl(hotspot.lat, hotspot.lon)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-black text-stone-950 underline decoration-amber-400/70 underline-offset-4 hover:text-orange-800"
        >
          {placeLabel(hotspot)}
        </a>
        <div className="mt-1 text-xs font-semibold text-stone-500">
          {hotspot.lat.toFixed(2)}, {hotspot.lon.toFixed(2)}
        </div>
      </td>
      <td className="px-4 py-4 text-right">
        <WetBulbBadge value={hotspot.peakWetBulbC} />
        <div className="mt-1 text-xs text-stone-500">{formatTime(hotspot.peakWetBulbTime)}</div>
      </td>
      <td className="hidden px-4 py-4 text-right font-bold text-stone-800 sm:table-cell">
        {hotspot.peakTempC.toFixed(1)}°C
      </td>
      <td className="hidden px-4 py-4 text-right font-bold text-stone-800 md:table-cell">
        {hotspot.rhAtPeakTemp.toFixed(0)}%
      </td>
      <td className="hidden px-4 py-4 text-right font-bold text-stone-800 lg:table-cell">
        {formatPopulation(hotspot.city.population)}
      </td>
      <td className="hidden px-4 py-4 text-right text-sm font-semibold text-stone-600 xl:table-cell">
        {hotspot.hotHours.length}
      </td>
    </tr>
  );
}

export default function InhabitedHotspotResults({
  data,
  dataSource,
  isLoading,
  error,
}: InhabitedHotspotResultsProps) {
  if (isLoading && data == null) {
    return (
      <div className="border border-stone-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-amber-200 border-t-orange-700" />
        <p className="mt-4 font-semibold text-stone-700">Loading inhabited hotspot ranking...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 p-6 text-red-800 shadow-sm">
        <p className="font-bold">Inhabited ranking unavailable</p>
        <p className="mt-2 text-sm">{error}</p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const leader = data.hotspots[0] ?? null;
  const expiresAt = data.snapshot.expiresAt ? new Date(data.snapshot.expiresAt) : null;
  const isExpired = expiresAt ? expiresAt.getTime() < Date.now() : false;
  const isFallback = dataSource === 'bundled-fallback';

  return (
    <section className="space-y-5">
      {(isFallback || isExpired) && (
        <div className="border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-950 shadow-sm">
          {isFallback && (
            <p>Showing bundled fallback data because fresh Blob data is unavailable.</p>
          )}
          {isExpired && (
            <p className={isFallback ? 'mt-1' : undefined}>
              This forecast snapshot is expired; stale data remains visible for continuity.
            </p>
          )}
        </div>
      )}

      <div className="border border-stone-200 bg-white p-5 shadow-sm">
        <div className="grid gap-5 md:grid-cols-[1.4fr_0.6fr_0.6fr]">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-orange-700">
              Populated places forecast
            </p>
            <h2 className="mt-2 text-2xl font-black text-stone-950 md:text-3xl">
              {data.label}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
              Highest forecast wet-bulb among up to{' '}
              {(data.scan.maxCandidateCities ?? data.scan.citiesScanned).toLocaleString()}{' '}
              grid-prioritized populated places. Population threshold is greater than{' '}
              {data.minPopulation.toLocaleString()}. This is not an exhaustive global ranking.
            </p>
          </div>
          <div className="border-l-4 border-amber-400 pl-4">
            <p className="text-xs font-black uppercase text-stone-500">Cities scanned</p>
            <p className="mt-2 text-3xl font-black text-stone-950">
              {data.scan.citiesScanned.toLocaleString()}
            </p>
          </div>
          <div className="border-l-4 border-orange-700 pl-4">
            <p className="text-xs font-black uppercase text-stone-500">Current leader</p>
            <p className="mt-2 text-3xl font-black text-stone-950">
              {leader ? `${leader.peakWetBulbC.toFixed(1)}°C` : 'None'}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs font-bold text-stone-500">
          <span>Generated {formatTime(data.scan.generatedAt)}</span>
          <span>Expires {expiresAt ? formatTime(expiresAt.toISOString()) : 'not provided'}</span>
          <span>{data.scan.batchCount} Open-Meteo batches</span>
          <span>{(data.scan.populationQualifiedCities ?? 0).toLocaleString()} eligible cities</span>
          <span>{(data.scan.gridQualifiedCandidateCities ?? 0).toLocaleString()} grid-qualified</span>
          <span>{(data.scan.citiesExcludedByCandidateCap ?? 0).toLocaleString()} excluded by cap</span>
          <span>Top {data.limit}</span>
          <span>Forecast source, not realtime observations</span>
          <a
            href="https://open-meteo.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-700 underline underline-offset-2"
          >
            Weather data by Open-Meteo
          </a>
        </div>
      </div>

      <div className="overflow-hidden border border-stone-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="bg-stone-950 text-left text-xs font-black uppercase tracking-[0.12em] text-amber-50">
                <th className="px-4 py-3 text-center">Rank</th>
                <th className="px-4 py-3">Place</th>
                <th className="px-4 py-3 text-right">Wet bulb</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">Air temp</th>
                <th className="hidden px-4 py-3 text-right md:table-cell">Humidity</th>
                <th className="hidden px-4 py-3 text-right lg:table-cell">Population</th>
                <th className="hidden px-4 py-3 text-right xl:table-cell">Hot hours</th>
              </tr>
            </thead>
            <tbody>
              {data.hotspots.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center font-semibold text-stone-600">
                    No populated places crossed the configured thresholds.
                  </td>
                </tr>
              ) : (
                data.hotspots.map((hotspot, index) => (
                  <RankRow
                    key={`${hotspot.city.name}-${hotspot.city.countryCode}-${hotspot.lat}-${hotspot.lon}`}
                    hotspot={hotspot}
                    rank={index + 1}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
