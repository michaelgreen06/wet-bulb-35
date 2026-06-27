'use client';

import { useEffect, useMemo, useState } from 'react';
import HotspotFilters, { type HotspotFilterState } from '@/components/HotspotFilters';
import HotspotResults from '@/components/HotspotResults';
import type { HotspotCell, HotspotSnapshot } from '@/lib/types/hotspots';

const DEFAULT_FILTERS: HotspotFilterState = {
  sortBy: 'wetBulb',
  minWetBulb: 0,
  minTemperature: 0,
  limit: 50,
};

function sortHotspots(a: HotspotCell, b: HotspotCell, sortBy: HotspotFilterState['sortBy']) {
  if (sortBy === 'temperature') {
    return b.peakTempC - a.peakTempC || b.peakWetBulbC - a.peakWetBulbC;
  }

  if (sortBy === 'humidity') {
    return b.rhAtPeakTemp - a.rhAtPeakTemp || b.peakWetBulbC - a.peakWetBulbC;
  }

  if (sortBy === 'hotHours') {
    return b.hotHours.length - a.hotHours.length || b.peakWetBulbC - a.peakWetBulbC;
  }

  return b.peakWetBulbC - a.peakWetBulbC || b.peakTempC - a.peakTempC;
}

export default function HotspotDashboard() {
  const [filters, setFilters] = useState<HotspotFilterState>(DEFAULT_FILTERS);
  const [data, setData] = useState<HotspotSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const filteredData = useMemo(() => {
    if (!data) {
      return null;
    }

    return {
      ...data,
      limit: filters.limit,
      hotspots: [...data.hotspots]
        .filter((hotspot) => hotspot.peakWetBulbC >= filters.minWetBulb)
        .filter((hotspot) => hotspot.peakTempC >= filters.minTemperature)
        .sort((a, b) => sortHotspots(a, b, filters.sortBy))
        .slice(0, filters.limit),
    };
  }, [data, filters]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSnapshot() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch('/api/hotspots', {
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            typeof payload?.error === 'string'
              ? payload.error
              : 'Failed to load hotspot snapshot.',
          );
        }

        setData(payload as HotspotSnapshot);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }

        setError(err instanceof Error ? err.message : 'Failed to load hotspot snapshot.');
      } finally {
        setIsLoading(false);
      }
    }

    loadSnapshot();

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div className="space-y-8">
      <HotspotFilters
        filters={filters}
        onChange={setFilters}
      />
      <HotspotResults data={filteredData} isLoading={isLoading} error={error} />
    </div>
  );
}
