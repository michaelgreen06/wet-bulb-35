import { scanRegionForHotspots } from '@/lib/utils/hotspotScan';
import path from 'node:path';
import { scanPopulatedPlacesForHotspots } from '@/lib/utils/inhabitedHotspotScan';
import {
  writeHotspotSnapshot,
  writeInhabitedHotspotSnapshot,
} from '@/lib/utils/hotspotSnapshot';
import {
  enrichHotspotsWithNearestLocations,
  loadResolvedCities,
} from '@/lib/utils/hotspotLocations';
import { loadPopulatedCities } from '@/lib/utils/inhabitedHotspotLocations';
import type { HotspotSnapshot, InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

const startedAt = Date.now();

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);

  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

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
  const forecastHours = parsePositiveIntEnv('INHABITED_FORECAST_HOURS', 24);
  const maxCandidateCities = parsePositiveIntEnv('INHABITED_MAX_CANDIDATE_CITIES', 7000);
  const gateTempThresholdC = parsePositiveIntEnv('INHABITED_GATE_TEMP_THRESHOLD_C', 30);
  const gateWetBulbThresholdC = parsePositiveIntEnv('INHABITED_GATE_WETBULB_THRESHOLD_C', 26);
  const gateRadiusKm = parsePositiveIntEnv('INHABITED_GATE_RADIUS_KM', 600);
  const batchSize = parsePositiveIntEnv('OPEN_METEO_BATCH_SIZE', 75);
  const checkpointPath =
    process.env.INHABITED_CHECKPOINT_PATH ||
    path.join(process.cwd(), '.cache', 'inhabited-hotspots-checkpoint.json');
  const maxLocationsPerMinute = parsePositiveIntEnv('OPEN_METEO_MAX_LOCATIONS_PER_MINUTE', 450);
  const maxLocationsPerHour = parsePositiveIntEnv('OPEN_METEO_MAX_LOCATIONS_PER_HOUR', 4500);

  console.log('Starting combined hotspot snapshot generation...');
  console.log(
    `Daily budget target: global scan plus up to ${maxCandidateCities.toLocaleString()} inhabited city calls`,
  );
  console.log(`Inhabited checkpoint: ${checkpointPath}`);

  const globalScan = await scanRegionForHotspots(
    {
      regionId: 'global',
      forecastHours,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      limit: 200,
    },
    {
      gate: {
        tempThresholdC: gateTempThresholdC,
        wetBulbThresholdC: gateWetBulbThresholdC,
      },
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
          return;
        }

        console.log(
          `[${event.phase}] batch ${event.batchIndex}/${event.batchCount} complete, ` +
            `${event.locationsCompleted.toLocaleString()}/${event.totalLocations.toLocaleString()} locations, ` +
            `${event.cellsEvaluated.toLocaleString()} cells evaluated`,
        );
      },
    },
  );

  const { gateCells = [], ...globalScanForSnapshot } = globalScan;
  const resolvedCities = await loadResolvedCities();
  const globalHotspots = enrichHotspotsWithNearestLocations(globalScan.hotspots, resolvedCities);
  const globalSnapshot: HotspotSnapshot = {
    ...globalScanForSnapshot,
    scan: {
      ...globalScan.scan,
      cacheHit: false,
    },
    hotspots: globalHotspots,
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: addHours(new Date(globalScan.scan.generatedAt), 30).toISOString(),
    },
  };

  await writeHotspotSnapshot(globalSnapshot);
  console.log(
    `Generated ${globalSnapshot.hotspots.length} global hotspots and ${gateCells.length.toLocaleString()} inhabited gate cells`,
  );

  const populatedCities = await loadPopulatedCities();
  const inhabitedScan = await scanPopulatedPlacesForHotspots(
    populatedCities,
    {
      forecastHours,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      minPopulation: 25000,
      limit: 50,
    },
    {
      batchSize,
      checkpointPath,
      gateCells,
      gateRadiusKm,
      maxCandidateCities,
      maxLocationsPerMinute,
      maxLocationsPerHour,
      onProgress(event) {
        if (event.type === 'phase-start') {
          console.log(
            `[inhabited] ${event.totalLocations.toLocaleString()} cities across ${event.batchCount} batches`,
          );
          return;
        }

        if (event.type === 'throttle') {
          const label =
            event.reason === 'rate-limit'
              ? 'rate-limit recovery'
              : event.reason === 'transient-error'
                ? 'Open-Meteo transient error recovery'
                : 'planned throttle';
          const quotaWindow = event.quotaWindow ?? 'minute';
          console.log(
            `[inhabited] ${label} for ${formatDuration(event.delayMs)} after ${event.locationsInWindow}/${event.maxLocationsPerMinute} locations in current ${quotaWindow}`,
          );
          return;
        }

        console.log(
          `[inhabited] batch ${event.batchIndex}/${event.batchCount} complete, ` +
            `${event.locationsCompleted.toLocaleString()}/${event.totalLocations.toLocaleString()} cities, ` +
            `${event.cellsEvaluated.toLocaleString()} hotspots evaluated` +
            `${event.skipped ? ' (checkpoint)' : ''}`,
        );
      },
    },
  );

  const inhabitedSnapshot: InhabitedHotspotSnapshot = {
    ...inhabitedScan,
    scan: {
      ...inhabitedScan.scan,
      cacheHit: false,
    },
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: addHours(new Date(inhabitedScan.scan.generatedAt), 30).toISOString(),
    },
  };

  await writeInhabitedHotspotSnapshot(inhabitedSnapshot);
  console.log(
    `Generated ${inhabitedSnapshot.hotspots.length} inhabited hotspots at ${inhabitedSnapshot.scan.generatedAt} in ${formatDuration(Date.now() - startedAt)}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
