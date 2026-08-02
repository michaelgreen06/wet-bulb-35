import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  InhabitedHotspotCell,
  InhabitedHotspotScanRequest,
  InhabitedHotspotScanResponse,
  EvaluatedHotspotCell,
  HotspotCell,
  PopulatedCity,
} from '@/lib/types/hotspots';
import {
  fetchOpenMeteoBatch,
  OpenMeteoRateLimitError,
  OpenMeteoTransientError,
  type ForecastCoord,
} from '@/lib/utils/openMeteoForecast';
import {
  chunkCoords,
  summarizeForecastPoint,
  type HotspotScanProgressEvent,
} from '@/lib/utils/hotspotScan';
import { filterPopulatedCities } from '@/lib/utils/inhabitedHotspotLocations';
import { getHaversineDistanceKm } from '@/lib/utils/hotspotGeo';

const DEFAULT_BATCH_SIZE = 75;
const DEFAULT_MAX_LOCATIONS_PER_MINUTE = 450;
const DEFAULT_MAX_LOCATIONS_PER_HOUR = 4500;
const DEFAULT_GATE_RADIUS_KM = 600;
const DEFAULT_MAX_CANDIDATE_CITIES = 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const MAX_CONSECUTIVE_RATE_LIMITS = 6;
const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 8;

type InhabitedHotspotScanOptions = {
  batchSize?: number;
  checkpointPath?: string;
  gatingMode?: 'radius' | 'grid-cell';
  gateCells?: HotspotCell[];
  gateRadiusKm?: number;
  evaluatedCells?: EvaluatedHotspotCell[];
  gateTempThresholdC?: number;
  gateWetBulbThresholdC?: number;
  maxCandidateCities?: number;
  maxLocationsPerMinute?: number;
  maxLocationsPerHour?: number;
  onProgress?: (event: HotspotScanProgressEvent) => void;
};

type RateLimitState = {
  windowStartedAt: number;
  locationsInWindow: number;
};

type InhabitedHotspotCheckpoint = {
  version: 2;
  key: string;
  request: InhabitedHotspotScanRequest;
  createdAt: string;
  updatedAt: string;
  batchSize: number;
  candidateCities: PopulatedCity[];
  completedBatches: Array<{
    batchIndex: number;
    locationsCompleted: number;
    hotspots: InhabitedHotspotCell[];
  }>;
};

function toUtcIsoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getCheckpointKey(args: {
  request: InhabitedHotspotScanRequest;
  batchSize: number;
  candidateCities: PopulatedCity[];
  gatingMode: 'radius' | 'grid-cell' | 'population';
  gateTempThresholdC: number;
  gateWetBulbThresholdC: number;
  gateRadiusKm: number;
  maxCandidateCities: number;
  maxLocationsPerMinute: number;
  maxLocationsPerHour: number;
}): string {
  return JSON.stringify({
    request: args.request,
    batchSize: args.batchSize,
    gatingMode: args.gatingMode,
    gateTempThresholdC: args.gateTempThresholdC,
    gateWetBulbThresholdC: args.gateWetBulbThresholdC,
    gateRadiusKm: args.gateRadiusKm,
    maxCandidateCities: args.maxCandidateCities,
    maxLocationsPerMinute: args.maxLocationsPerMinute,
    maxLocationsPerHour: args.maxLocationsPerHour,
    candidateCities: args.candidateCities.map((city) => [
      city.name,
      city.countryCode,
      city.country,
      city.admin1Code,
      city.admin1,
      city.latitude,
      city.longitude,
      city.population,
    ]),
  });
}

async function loadCheckpoint(
  checkpointPath: string | undefined,
  key: string,
): Promise<InhabitedHotspotCheckpoint | null> {
  if (!checkpointPath) {
    return null;
  }

  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    const checkpoint = JSON.parse(raw) as InhabitedHotspotCheckpoint;

    if (checkpoint.version !== 2 || checkpoint.key !== key) {
      return null;
    }

    return checkpoint;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function writeCheckpoint(
  checkpointPath: string | undefined,
  checkpoint: InhabitedHotspotCheckpoint,
): Promise<void> {
  if (!checkpointPath) {
    return;
  }

  checkpoint.updatedAt = toUtcIsoSecond(new Date());
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

async function deleteCheckpoint(checkpointPath: string | undefined): Promise<void> {
  if (!checkpointPath) {
    return;
  }

  await fs.rm(checkpointPath, { force: true });
}

function sortInhabitedHotspots(a: InhabitedHotspotCell, b: InhabitedHotspotCell): number {
  return (
    b.peakWetBulbC - a.peakWetBulbC ||
    b.peakTempC - a.peakTempC ||
    b.rhAtPeakTemp - a.rhAtPeakTemp ||
    b.city.population - a.city.population
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cityCoord(city: PopulatedCity): ForecastCoord {
  return {
    lat: city.latitude,
    lon: city.longitude,
  };
}

function selectGatedCandidateCities(
  cities: PopulatedCity[],
  gateCells: HotspotCell[] | undefined,
  gateRadiusKm: number,
  maxCandidateCities: number,
): PopulatedCity[] {
  if (!gateCells || gateCells.length === 0) {
    return cities.slice(0, maxCandidateCities);
  }

  const candidates = cities.flatMap((city) => {
    let bestGate: HotspotCell | null = null;
    let bestDistanceKm = Number.POSITIVE_INFINITY;

    for (const gateCell of gateCells) {
      const distanceKm = getHaversineDistanceKm(
        { lat: city.latitude, lon: city.longitude },
        { lat: gateCell.lat, lon: gateCell.lon },
      );

      if (distanceKm <= gateRadiusKm && distanceKm < bestDistanceKm) {
        bestGate = gateCell;
        bestDistanceKm = distanceKm;
      }
    }

    if (!bestGate) {
      return [];
    }

    return [{
      city,
      gateCell: bestGate,
      distanceKm: bestDistanceKm,
    }];
  });

  return candidates
    .sort(
      (a, b) =>
        b.gateCell.peakWetBulbC - a.gateCell.peakWetBulbC ||
        b.gateCell.peakTempC - a.gateCell.peakTempC ||
        a.distanceKm - b.distanceKm ||
        b.city.population - a.city.population,
    )
    .slice(0, maxCandidateCities)
    .map((candidate) => candidate.city);
}

type GatedCity = {
  city: PopulatedCity;
  gateCell: HotspotCell;
  distanceKm: number;
};

function compareGridGatedCities(a: GatedCity, b: GatedCity): number {
  return (
    b.gateCell.peakWetBulbC - a.gateCell.peakWetBulbC ||
    b.gateCell.peakTempC - a.gateCell.peakTempC ||
    b.city.population - a.city.population ||
    a.distanceKm - b.distanceKm ||
    a.city.name.localeCompare(b.city.name) ||
    (a.city.countryCode ?? '').localeCompare(b.city.countryCode ?? '') ||
    a.city.latitude - b.city.latitude ||
    a.city.longitude - b.city.longitude
  );
}

function longitudeDistanceDeg(a: number, b: number): number {
  const delta = ((a - b + 540) % 360) - 180;
  return Math.abs(delta);
}

function selectGridGatedCandidateCities(
  cities: PopulatedCity[],
  evaluatedCells: EvaluatedHotspotCell[],
  gateTempThresholdC: number,
  gateWetBulbThresholdC: number,
  maxCandidateCities: number,
): { candidateCities: PopulatedCity[]; gridQualifiedCandidateCities: number; warmCells: number } {
  const warmCells = evaluatedCells.filter(
    (cell) =>
      cell.peakTempC >= gateTempThresholdC ||
      cell.peakWetBulbC >= gateWetBulbThresholdC,
  );
  const qualifiedCities = cities.flatMap((city): GatedCity[] => {
    let bestGate: EvaluatedHotspotCell | null = null;
    let bestDistanceKm = Number.POSITIVE_INFINITY;

    for (const gateCell of warmCells) {
      // Half a cell covers the cell itself; one more full step covers its eight neighbors.
      const gateReachDeg = gateCell.sourceStepDeg * 1.5;
      if (
        Math.abs(city.latitude - gateCell.lat) > gateReachDeg ||
        longitudeDistanceDeg(city.longitude, gateCell.lon) > gateReachDeg
      ) {
        continue;
      }

      const distanceKm = getHaversineDistanceKm(
        { lat: city.latitude, lon: city.longitude },
        { lat: gateCell.lat, lon: gateCell.lon },
      );
      const candidate = { city, gateCell, distanceKm };
      if (
        !bestGate ||
        compareGridGatedCities(candidate, {
          city,
          gateCell: bestGate,
          distanceKm: bestDistanceKm,
        }) < 0
      ) {
        bestGate = gateCell;
        bestDistanceKm = distanceKm;
      }
    }

    return bestGate ? [{ city, gateCell: bestGate, distanceKm: bestDistanceKm }] : [];
  });

  return {
    candidateCities: qualifiedCities
      .sort(compareGridGatedCities)
      .slice(0, maxCandidateCities)
      .map(({ city }) => city),
    gridQualifiedCandidateCities: qualifiedCities.length,
    warmCells: warmCells.length,
  };
}

async function waitForCapacity(
  phase: HotspotScanProgressEvent['phase'],
  quotaWindow: 'minute' | 'hour',
  chunkSize: number,
  maxLocations: number,
  windowMs: number,
  rateLimitState: RateLimitState,
  options: InhabitedHotspotScanOptions,
): Promise<void> {
  if (
    process.env.NODE_ENV === 'test' ||
    rateLimitState.locationsInWindow + chunkSize <= maxLocations
  ) {
    return;
  }

  const elapsedMs = Date.now() - rateLimitState.windowStartedAt;
  const delayMs = Math.max(0, windowMs - elapsedMs);

  if (delayMs > 0) {
    options.onProgress?.({
      type: 'throttle',
      phase,
      delayMs,
      locationsInWindow: rateLimitState.locationsInWindow,
      maxLocationsPerMinute: maxLocations,
      reason: 'planned',
      quotaWindow,
    });
    await sleep(delayMs);
  }

  rateLimitState.windowStartedAt = Date.now();
  rateLimitState.locationsInWindow = 0;
}

async function fetchCityBatch(
  cities: PopulatedCity[],
  request: InhabitedHotspotScanRequest,
  maxLocationsPerMinute: number,
  maxLocationsPerHour: number,
  minuteLimitState: RateLimitState,
  hourLimitState: RateLimitState,
  options: InhabitedHotspotScanOptions,
): Promise<InhabitedHotspotCell[]> {
  let consecutiveRateLimits = 0;
  let consecutiveTransientErrors = 0;

  await waitForCapacity(
    'coarse',
    'minute',
    cities.length,
    maxLocationsPerMinute,
    ONE_MINUTE_MS,
    minuteLimitState,
    options,
  );
  await waitForCapacity(
    'coarse',
    'hour',
    cities.length,
    maxLocationsPerHour,
    ONE_HOUR_MS,
    hourLimitState,
    options,
  );

  while (true) {
    try {
      const forecasts = await fetchOpenMeteoBatch({
        coords: cities.map(cityCoord),
        forecastHours: request.forecastHours,
        landFocused: true,
      });

      minuteLimitState.locationsInWindow += cities.length;
      hourLimitState.locationsInWindow += cities.length;
      consecutiveRateLimits = 0;
      consecutiveTransientErrors = 0;

      return forecasts.flatMap((forecast, index) => {
        const cell = summarizeForecastPoint(forecast, request);

        if (!cell?.isHotspot) {
          return [];
        }

        const { isHotspot: _isHotspot, ...hotspot } = cell;

        return [{
          ...hotspot,
          city: cities[index],
        }];
      });
    } catch (error) {
      if (error instanceof OpenMeteoRateLimitError) {
        consecutiveRateLimits += 1;
        const hourlyWindowDelayMs =
          error.limitKind === 'hourly'
            ? Math.max(0, ONE_HOUR_MS - (Date.now() - hourLimitState.windowStartedAt))
            : 0;
        const adaptiveDelayMs = Math.min(
          Math.max(error.retryAfterMs * consecutiveRateLimits, hourlyWindowDelayMs),
          error.limitKind === 'hourly' ? ONE_HOUR_MS : 10 * 60 * 1000,
        );

        if (consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMITS) {
          throw new Error(
            `Open-Meteo is still rate-limiting after ${MAX_CONSECUTIVE_RATE_LIMITS} recovery waits. ` +
              'Stop this run and retry later, or lower maxLocationsPerMinute/maxLocationsPerHour.',
          );
        }

        const quotaWindow = error.limitKind === 'hourly' ? 'hour' : 'minute';

        options.onProgress?.({
          type: 'throttle',
          phase: 'coarse',
          delayMs: adaptiveDelayMs,
          locationsInWindow:
            quotaWindow === 'hour'
              ? hourLimitState.locationsInWindow
              : minuteLimitState.locationsInWindow,
          maxLocationsPerMinute:
            quotaWindow === 'hour' ? maxLocationsPerHour : maxLocationsPerMinute,
          reason: 'rate-limit',
          quotaWindow,
          errorMessage: error.message,
          responseBody: error.responseBody,
          retryAfterHeader: error.retryAfterHeader,
          limitKind: error.limitKind,
        });
        await sleep(adaptiveDelayMs);

        if (quotaWindow === 'hour') {
          hourLimitState.windowStartedAt = Date.now();
          hourLimitState.locationsInWindow = 0;
        } else {
          minuteLimitState.windowStartedAt = Date.now();
          minuteLimitState.locationsInWindow = 0;
        }

        continue;
      }

      if (error instanceof OpenMeteoTransientError) {
        consecutiveTransientErrors += 1;
        const adaptiveDelayMs = Math.min(
          error.retryAfterMs * consecutiveTransientErrors,
          3 * 60 * 1000,
        );

        if (consecutiveTransientErrors > MAX_CONSECUTIVE_TRANSIENT_ERRORS) {
          throw new Error(
            `Open-Meteo kept returning transient ${error.status} errors after ${MAX_CONSECUTIVE_TRANSIENT_ERRORS} recovery waits. ` +
              'Retry later, or lower batchSize/maxLocationsPerMinute for inhabited scans.',
          );
        }

        options.onProgress?.({
          type: 'throttle',
          phase: 'coarse',
          delayMs: adaptiveDelayMs,
          locationsInWindow: minuteLimitState.locationsInWindow,
          maxLocationsPerMinute,
          reason: 'transient-error',
          quotaWindow: 'minute',
          errorMessage: error.message,
          responseBody: error.responseBody,
          retryAfterHeader: error.retryAfterHeader,
          limitKind: 'unknown',
        });
        await sleep(adaptiveDelayMs);
        minuteLimitState.windowStartedAt = Date.now();
        minuteLimitState.locationsInWindow = 0;
        continue;
      }

      throw error;
    }
  }
}

export async function scanPopulatedPlacesForHotspots(
  cities: PopulatedCity[],
  request: InhabitedHotspotScanRequest,
  options: InhabitedHotspotScanOptions = {},
): Promise<InhabitedHotspotScanResponse> {
  const populationQualifiedCities = filterPopulatedCities(cities, request.minPopulation);
  const gateRadiusKm = options.gateRadiusKm ?? DEFAULT_GATE_RADIUS_KM;
  const maxCandidateCities = options.maxCandidateCities ?? DEFAULT_MAX_CANDIDATE_CITIES;
  const gateTempThresholdC = options.gateTempThresholdC ?? 30;
  const gateWetBulbThresholdC = options.gateWetBulbThresholdC ?? 26;
  const gatingMode =
    options.gatingMode ??
    (options.evaluatedCells ? 'grid-cell' : options.gateCells ? 'radius' : 'population');
  const gridSelection = gatingMode === 'grid-cell'
    ? selectGridGatedCandidateCities(
      populationQualifiedCities,
      options.evaluatedCells ?? [],
      gateTempThresholdC,
      gateWetBulbThresholdC,
      maxCandidateCities,
    )
    : null;
  const candidateCities = gridSelection?.candidateCities ?? selectGatedCandidateCities(
    populationQualifiedCities,
    gatingMode === 'radius' ? options.gateCells : undefined,
    gateRadiusKm,
    maxCandidateCities,
  );
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxLocationsPerMinute =
    options.maxLocationsPerMinute ?? DEFAULT_MAX_LOCATIONS_PER_MINUTE;
  const maxLocationsPerHour = options.maxLocationsPerHour ?? DEFAULT_MAX_LOCATIONS_PER_HOUR;
  const chunks = chunkCoords(candidateCities, batchSize);
  const checkpointKey = getCheckpointKey({
    request,
    batchSize,
    candidateCities,
    gatingMode,
    gateTempThresholdC,
    gateWetBulbThresholdC,
    gateRadiusKm,
    maxCandidateCities,
    maxLocationsPerMinute,
    maxLocationsPerHour,
  });
  const existingCheckpoint = await loadCheckpoint(options.checkpointPath, checkpointKey);
  const completedBatches = new Map(
    existingCheckpoint?.completedBatches.map((batch) => [batch.batchIndex, batch]) ?? [],
  );
  const checkpoint: InhabitedHotspotCheckpoint = existingCheckpoint ?? {
    version: 2,
    key: checkpointKey,
    request,
    createdAt: toUtcIsoSecond(new Date()),
    updatedAt: toUtcIsoSecond(new Date()),
    batchSize,
    candidateCities,
    completedBatches: [],
  };
  const minuteLimitState = {
    windowStartedAt: Date.now(),
    locationsInWindow: 0,
  };
  const hourLimitState = {
    windowStartedAt: Date.now(),
    locationsInWindow: 0,
  };
  const hotspots: InhabitedHotspotCell[] = [];
  let locationsCompleted = 0;

  options.onProgress?.({
    type: 'phase-start',
    phase: 'coarse',
    totalLocations: candidateCities.length,
    batchCount: chunks.length,
  });

  for (const [index, chunk] of chunks.entries()) {
    const batchIndex = index + 1;
    const completedBatch = completedBatches.get(batchIndex);

    if (completedBatch) {
      hotspots.push(...completedBatch.hotspots);
      locationsCompleted += chunk.length;

      options.onProgress?.({
        type: 'batch-complete',
        phase: 'coarse',
        batchIndex,
        batchCount: chunks.length,
        locationsCompleted,
        totalLocations: candidateCities.length,
        cellsEvaluated: hotspots.length,
        skipped: true,
      });
      continue;
    }

    const batchHotspots = await fetchCityBatch(
      chunk,
      request,
      maxLocationsPerMinute,
      maxLocationsPerHour,
      minuteLimitState,
      hourLimitState,
      options,
    );
    hotspots.push(...batchHotspots);
    checkpoint.completedBatches.push({
      batchIndex,
      locationsCompleted: locationsCompleted + chunk.length,
      hotspots: batchHotspots,
    });
    await writeCheckpoint(options.checkpointPath, checkpoint);
    locationsCompleted += chunk.length;

    options.onProgress?.({
      type: 'batch-complete',
      phase: 'coarse',
      batchIndex,
      batchCount: chunks.length,
      locationsCompleted,
      totalLocations: candidateCities.length,
      cellsEvaluated: hotspots.length,
    });
  }

  await deleteCheckpoint(options.checkpointPath);

  return {
    schemaVersion: 1,
    label: `Highest forecast wet-bulb at populated places in the next ${request.forecastHours} hours.`,
    scan: {
      algorithm: 'grid-cell-v1',
      forecastHours: request.forecastHours,
      candidateCities: candidateCities.length,
      populationQualifiedCities: populationQualifiedCities.length,
      gridQualifiedCandidateCities: gridSelection?.gridQualifiedCandidateCities,
      citiesExcludedByCandidateCap: gridSelection
        ? gridSelection.gridQualifiedCandidateCities - candidateCities.length
        : undefined,
      gateCells: gridSelection?.warmCells ?? options.gateCells?.length,
      gateRadiusKm: gatingMode === 'radius' && options.gateCells ? gateRadiusKm : undefined,
      gatingMode: gatingMode === 'population' ? undefined : gatingMode,
      maxCandidateCities,
      citiesScanned: candidateCities.length,
      batchCount: chunks.length,
      generatedAt: toUtcIsoSecond(new Date()),
      cacheHit: false,
    },
    thresholds: {
      tempC: request.tempThresholdC,
      wetBulbC: request.wetBulbThresholdC,
    },
    minPopulation: request.minPopulation,
    limit: request.limit,
    hotspots: hotspots.sort(sortInhabitedHotspots).slice(0, request.limit),
  };
}
