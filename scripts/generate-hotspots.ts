import { scanRegionForHotspots } from '@/lib/utils/hotspotScan';
import { writeHotspotSnapshot } from '@/lib/utils/hotspotSnapshot';
import {
  enrichHotspotsWithNearestLocations,
  loadResolvedCities,
} from '@/lib/utils/hotspotLocations';
import type { HotspotSnapshot } from '@/lib/types/hotspots';

const startedAt = Date.now();

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

async function main() {
  console.log('Starting global hotspot snapshot generation...');
  console.log('Scan: global, 24h, temp >= 35C or wet bulb >= 30C, output top 200');
  console.log('Throttle: 75 locations/batch, 450 locations/minute');

  const scan = await scanRegionForHotspots({
    regionId: 'global',
    forecastHours: 24,
    tempThresholdC: 35,
    wetBulbThresholdC: 30,
    limit: 200,
  }, {
    onProgress(event) {
      if (event.type === 'phase-start') {
        console.log(
          `[${event.phase}] ${event.totalLocations.toLocaleString()} locations across ${event.batchCount} batches`,
        );
        return;
      }

      if (event.type === 'throttle') {
        const label = event.reason === 'rate-limit' ? 'rate-limit recovery' : 'planned throttle';
        console.log(
          `[${event.phase}] ${label} for ${formatDuration(event.delayMs)} after ${event.locationsInWindow}/${event.maxLocationsPerMinute} locations in current minute`,
        );

        if (event.reason === 'rate-limit') {
          console.log(
            `[${event.phase}] Open-Meteo 429 details: kind=${event.limitKind ?? 'unknown'} retry-after=${event.retryAfterHeader ?? 'not provided'} body=${event.responseBody || event.errorMessage || 'not provided'}`,
          );
        }

        return;
      }

      console.log(
        `[${event.phase}] batch ${event.batchIndex}/${event.batchCount} complete, ` +
          `${event.locationsCompleted.toLocaleString()}/${event.totalLocations.toLocaleString()} locations, ` +
          `${event.cellsEvaluated.toLocaleString()} cells evaluated`,
      );
    },
  });
  const cities = await loadResolvedCities();
  const hotspots = enrichHotspotsWithNearestLocations(scan.hotspots, cities);

  const snapshot: HotspotSnapshot = {
    ...scan,
    scan: {
      ...scan.scan,
      cacheHit: false,
    },
    hotspots,
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: addHours(new Date(scan.scan.generatedAt), 30).toISOString(),
    },
  };

  await writeHotspotSnapshot(snapshot);
  console.log(
    `Generated ${snapshot.hotspots.length} hotspots at ${snapshot.scan.generatedAt} in ${formatDuration(Date.now() - startedAt)} -> public/data/hotspots/latest.json`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
