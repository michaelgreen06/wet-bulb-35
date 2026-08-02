import path from 'node:path';
import { writeInhabitedHotspotSnapshot } from '@/lib/utils/hotspotSnapshot';
import { loadPopulatedCities } from '@/lib/utils/inhabitedHotspotLocations';
import { scanPopulatedPlacesForHotspots } from '@/lib/utils/inhabitedHotspotScan';
import { scanRegionForHotspots } from '@/lib/utils/hotspotScan';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

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
  const tempThresholdC = parsePositiveIntEnv('INHABITED_TEMP_THRESHOLD_C', 35);
  const wetBulbThresholdC = parsePositiveIntEnv('INHABITED_WETBULB_THRESHOLD_C', 30);
  const gateTempThresholdC = parsePositiveIntEnv('INHABITED_GATE_TEMP_THRESHOLD_C', 30);
  const gateWetBulbThresholdC = parsePositiveIntEnv('INHABITED_GATE_WETBULB_THRESHOLD_C', 26);
  const minPopulation = parsePositiveIntEnv('INHABITED_MIN_POPULATION', 25000);
  const limit = parsePositiveIntEnv('INHABITED_HOTSPOT_LIMIT', 50);
  const maxCandidateCities = parsePositiveIntEnv('INHABITED_MAX_CANDIDATE_CITIES', 1000);
  const batchSize = parsePositiveIntEnv('OPEN_METEO_BATCH_SIZE', 75);
  const checkpointPath =
    process.env.INHABITED_CHECKPOINT_PATH ||
    path.join(process.cwd(), '.cache', 'inhabited-hotspots-checkpoint.json');
  const maxLocationsPerMinute = parsePositiveIntEnv('OPEN_METEO_MAX_LOCATIONS_PER_MINUTE', 450);
  const maxLocationsPerHour = parsePositiveIntEnv('OPEN_METEO_MAX_LOCATIONS_PER_HOUR', 4500);

  console.log('Starting inhabited hotspot snapshot generation...');
  console.log(
    `Scan: grid-cell-v1, population > ${minPopulation.toLocaleString()}, ` +
      `${forecastHours}h, temp >= ${tempThresholdC}C or wet bulb >= ${wetBulbThresholdC}C, ` +
      `output top ${limit}, exact scan cap ${maxCandidateCities.toLocaleString()} cities`,
  );
  console.log(
    `Grid gate: temp >= ${gateTempThresholdC}C or wet bulb >= ${gateWetBulbThresholdC}C`,
  );
  console.log(
    `Throttle: ${batchSize} locations/batch, ` +
      `${maxLocationsPerMinute.toLocaleString()} locations/minute, ` +
      `${maxLocationsPerHour.toLocaleString()} locations/hour`,
  );
  console.log(`Checkpoint: ${checkpointPath}`);

  const gridScan = await scanRegionForHotspots(
    {
      regionId: 'global',
      forecastHours,
      tempThresholdC: gateTempThresholdC,
      wetBulbThresholdC: gateWetBulbThresholdC,
      limit: 50,
    },
    {
      includeEvaluatedCells: true,
      gate: {
        tempThresholdC: gateTempThresholdC,
        wetBulbThresholdC: gateWetBulbThresholdC,
      },
      onProgress(event) {
        if (event.type === 'phase-start') {
          console.log(
            `[grid] ${event.phase}: ${event.totalLocations.toLocaleString()} points across ${event.batchCount} batches`,
          );
          return;
        }

        if (event.type === 'throttle') {
          console.log(
            `[grid] ${event.phase} throttle for ${formatDuration(event.delayMs)}`,
          );
          return;
        }

        console.log(
          `[grid] ${event.phase} batch ${event.batchIndex}/${event.batchCount} complete, ` +
            `${event.locationsCompleted.toLocaleString()}/${event.totalLocations.toLocaleString()} points`,
        );
      },
    },
  );
  console.log(
    `Grid scan evaluated ${gridScan.evaluatedCells?.length.toLocaleString() ?? '0'} cells; ` +
      `${gridScan.gateCells?.length.toLocaleString() ?? '0'} cells qualified the gate`,
  );

  const populatedCities = await loadPopulatedCities();
  const scan = await scanPopulatedPlacesForHotspots(
    populatedCities,
    {
      forecastHours,
      tempThresholdC,
      wetBulbThresholdC,
      minPopulation,
      limit,
    },
    {
      batchSize,
      checkpointPath,
      gatingMode: 'grid-cell',
      evaluatedCells: gridScan.evaluatedCells ?? [],
      gateTempThresholdC,
      gateWetBulbThresholdC,
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

          if (event.reason === 'rate-limit' || event.reason === 'transient-error') {
            console.log(
              `[inhabited] Open-Meteo recovery details: kind=${event.limitKind ?? 'unknown'} retry-after=${event.retryAfterHeader ?? 'not provided'} body=${event.responseBody || event.errorMessage || 'not provided'}`,
            );
          }

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

  const snapshot: InhabitedHotspotSnapshot = {
    ...scan,
    scan: {
      ...scan.scan,
      cacheHit: false,
    },
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: addHours(new Date(scan.scan.generatedAt), 30).toISOString(),
    },
  };

  await writeInhabitedHotspotSnapshot(snapshot);
  const populationQualifiedCities = snapshot.scan.populationQualifiedCities ?? 0;
  const citiesExcludedByCap = Math.max(
    0,
    populationQualifiedCities - snapshot.scan.candidateCities,
  );
  console.log(
    `Population-qualified cities: ${populationQualifiedCities.toLocaleString()}`,
  );
  console.log(`Exact city scan cap: ${maxCandidateCities.toLocaleString()}`);
  console.log(`Cities excluded by cap: ${citiesExcludedByCap.toLocaleString()}`);
  console.log(`Actual exact city scans: ${snapshot.scan.candidateCities.toLocaleString()}`);
  console.log(
    `Generated ${snapshot.hotspots.length} inhabited hotspots at ${snapshot.scan.generatedAt} in ${formatDuration(Date.now() - startedAt)} -> public/data/hotspots/inhabited-latest.json`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
