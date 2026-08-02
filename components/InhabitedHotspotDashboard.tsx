'use client';

import { useEffect, useState } from 'react';
import InhabitedHotspotResults from '@/components/InhabitedHotspotResults';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

export default function InhabitedHotspotDashboard() {
  const [data, setData] = useState<InhabitedHotspotSnapshot | null>(null);
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSnapshot() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch('/api/inhabited-hotspots', {
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
              : 'Failed to load inhabited hotspot snapshot.',
          );
        }

        setDataSource(response.headers.get('X-Hotspot-Data-Source'));
        setData(payload as InhabitedHotspotSnapshot);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }

        setError(err instanceof Error ? err.message : 'Failed to load inhabited hotspot snapshot.');
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
    <InhabitedHotspotResults
      data={data}
      dataSource={dataSource}
      isLoading={isLoading}
      error={error}
    />
  );
}
