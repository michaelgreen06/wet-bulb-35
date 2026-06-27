import { HOTSPOT_REGIONS, getHotspotRegion } from '@/lib/config/hotspotRegions';
import type {
  HourlyCellSample,
  HotspotCell,
  HotspotRegionId,
  HotspotScanRequest,
  HotspotScanResponse,
  RegionConfig,
} from '@/lib/types/hotspots';
import {
  fetchOpenMeteoBatch,
  OpenMeteoRateLimitError,
  type ForecastCoord,
  type ForecastPoint,
} from '@/lib/utils/openMeteoForecast';
import { calculateForecastWetBulb } from '@/lib/utils/wetbulb';

const DEFAULT_BATCH_SIZE = 40;
const CACHE_TTL_MS = 10 * 60 * 1000;
const COORD_PRECISION = 4;
const ONE_MINUTE_MS = 60 * 1000;
const MAX_CONSECUTIVE_RATE_LIMITS = 6;

type EvaluatedCell = HotspotCell & {
  isHotspot: boolean;
};

export type HotspotScanProgressEvent =
  | {
      type: 'phase-start';
      phase: 'coarse' | 'refine';
      totalLocations: number;
      batchCount: number;
    }
  | {
      type: 'batch-complete';
      phase: 'coarse' | 'refine';
      batchIndex: number;
      batchCount: number;
      locationsCompleted: number;
      totalLocations: number;
      cellsEvaluated: number;
    }
  | {
      type: 'throttle';
      phase: 'coarse' | 'refine';
      delayMs: number;
      locationsInWindow: number;
      maxLocationsPerMinute: number;
      reason: 'planned' | 'rate-limit';
      errorMessage?: string;
      responseBody?: string;
      retryAfterHeader?: string | null;
      limitKind?: 'hourly' | 'minutely' | 'unknown';
    };

type HotspotScanOptions = {
  onProgress?: (event: HotspotScanProgressEvent) => void;
};

type RateLimitState = {
  windowStartedAt: number;
  locationsInWindow: number;
};

const cache = new Map<string, { expiresAt: number; data: HotspotScanResponse }>();

export function clearHotspotScanCache(): void {
  cache.clear();
}

function roundCoord(value: number): number {
  return Number(value.toFixed(COORD_PRECISION));
}

function coordKey(coord: ForecastCoord): string {
  return `${roundCoord(coord.lat)},${roundCoord(coord.lon)}`;
}

function normalizeLon(lon: number): number {
  if (lon < -180) {
    return roundCoord(lon + 360);
  }

  if (lon > 180) {
    return roundCoord(lon - 360);
  }

  return roundCoord(lon);
}

function toUtcIsoHour(time: string): string {
  if (time.endsWith('Z')) {
    return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  const withSeconds = time.length === 16 ? `${time}:00` : time;
  return new Date(`${withSeconds}Z`).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toUtcIsoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sortHotspots(a: HotspotCell, b: HotspotCell): number {
  return (
    b.peakWetBulbC - a.peakWetBulbC ||
    b.peakTempC - a.peakTempC ||
    b.rhAtPeakTemp - a.rhAtPeakTemp
  );
}

function getCacheKey(request: HotspotScanRequest): string {
  return JSON.stringify(request);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function generateGrid(region: RegionConfig): ForecastCoord[] {
  const coords: ForecastCoord[] = [];

  for (let lat = region.latMin; lat <= region.latMax + 1e-9; lat += region.stepDeg) {
    for (let lon = region.lonMin; lon <= region.lonMax + 1e-9; lon += region.stepDeg) {
      coords.push({ lat: roundCoord(lat), lon: roundCoord(lon) });
    }
  }

  return coords;
}

export function chunkCoords<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function generateRefinementGrid(
  center: ForecastCoord,
  region: RegionConfig,
): ForecastCoord[] {
  const step = region.refinedStepDeg ?? region.stepDeg;
  const radius = region.refinementRadiusDeg ?? region.stepDeg / 2;
  const coords: ForecastCoord[] = [];

  const latStart = Math.max(region.latMin, center.lat - radius);
  const latEnd = Math.min(region.latMax, center.lat + radius);
  const lonStart = center.lon - radius;
  const lonEnd = center.lon + radius;

  for (let lat = latStart; lat <= latEnd + 1e-9; lat += step) {
    for (let lon = lonStart; lon <= lonEnd + 1e-9; lon += step) {
      coords.push({ lat: roundCoord(lat), lon: normalizeLon(lon) });
    }
  }

  return coords;
}

export function summarizeForecastPoint(
  forecast: ForecastPoint,
  thresholds: Pick<HotspotScanRequest, 'tempThresholdC' | 'wetBulbThresholdC'>,
): EvaluatedCell | null {
  const times = forecast.hourly.time;
  const temps = forecast.hourly.temperature_2m;
  const humidities = forecast.hourly.relative_humidity_2m;

  if (times.length === 0 || temps.length !== times.length || humidities.length !== times.length) {
    return null;
  }

  let peakTempC = Number.NEGATIVE_INFINITY;
  let peakTempTime = '';
  let rhAtPeakTemp = 0;
  let peakWetBulbC = Number.NEGATIVE_INFINITY;
  let peakWetBulbTime = '';
  const hotHours: HourlyCellSample[] = [];

  for (let index = 0; index < times.length; index += 1) {
    const tempC = temps[index];
    const rh = humidities[index];

    if (!Number.isFinite(tempC) || !Number.isFinite(rh)) {
      continue;
    }

    const wetBulbC = calculateForecastWetBulb(tempC, rh);
    const time = toUtcIsoHour(times[index]);
    const sample = {
      time,
      tempC,
      rh,
      wetBulbC,
    };

    if (tempC > peakTempC) {
      peakTempC = tempC;
      peakTempTime = time;
      rhAtPeakTemp = rh;
    }

    if (wetBulbC > peakWetBulbC) {
      peakWetBulbC = wetBulbC;
      peakWetBulbTime = time;
    }

    if (tempC >= thresholds.tempThresholdC || wetBulbC >= thresholds.wetBulbThresholdC) {
      hotHours.push(sample);
    }
  }

  if (!Number.isFinite(peakTempC) || !Number.isFinite(peakWetBulbC)) {
    return null;
  }

  return {
    lat: roundCoord(forecast.latitude),
    lon: roundCoord(forecast.longitude),
    peakTempC,
    peakTempTime,
    rhAtPeakTemp,
    peakWetBulbC,
    peakWetBulbTime,
    hotHours,
    isHotspot: hotHours.length > 0,
  };
}

async function fetchAndEvaluate(
  phase: 'coarse' | 'refine',
  coords: ForecastCoord[],
  request: HotspotScanRequest,
  region: RegionConfig,
  rateLimitState: RateLimitState,
  options: HotspotScanOptions = {},
): Promise<{ cells: EvaluatedCell[]; batchCount: number }> {
  const chunks = chunkCoords(coords, region.batchSize ?? DEFAULT_BATCH_SIZE);
  const cells: EvaluatedCell[] = [];
  const maxLocationsPerMinute = region.maxLocationsPerMinute;
  let locationsCompleted = 0;
  let consecutiveRateLimits = 0;

  options.onProgress?.({
    type: 'phase-start',
    phase,
    totalLocations: coords.length,
    batchCount: chunks.length,
  });

  for (const [index, chunk] of chunks.entries()) {
    if (
      process.env.NODE_ENV !== 'test' &&
      maxLocationsPerMinute &&
      rateLimitState.locationsInWindow + chunk.length > maxLocationsPerMinute
    ) {
      const elapsedMs = Date.now() - rateLimitState.windowStartedAt;
      const delayMs = Math.max(0, ONE_MINUTE_MS - elapsedMs);

      if (delayMs > 0) {
        options.onProgress?.({
          type: 'throttle',
          phase,
          delayMs,
          locationsInWindow: rateLimitState.locationsInWindow,
          maxLocationsPerMinute,
          reason: 'planned',
        });
        await sleep(delayMs);
      }

      rateLimitState.windowStartedAt = Date.now();
      rateLimitState.locationsInWindow = 0;
    }

    let forecasts: ForecastPoint[] = [];

    while (true) {
      try {
        forecasts = await fetchOpenMeteoBatch({
          coords: chunk,
          forecastHours: request.forecastHours,
          landFocused: region.landFocused,
        });
        consecutiveRateLimits = 0;
        break;
      } catch (error) {
        if (error instanceof OpenMeteoRateLimitError) {
          if (error.limitKind === 'hourly') {
            throw new Error(
              `${error.message}\n` +
                'Open-Meteo reports the hourly API limit is exhausted. ' +
                'Retry after the hourly quota resets, reduce scan size, or split generation across multiple hours.',
            );
          }

          consecutiveRateLimits += 1;
          const adaptiveDelayMs = Math.min(
            error.retryAfterMs * consecutiveRateLimits,
            10 * 60 * 1000,
          );

          if (consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMITS) {
            throw new Error(
              `Open-Meteo is still rate-limiting after ${MAX_CONSECUTIVE_RATE_LIMITS} recovery waits. ` +
                'Stop this run and retry later, or lower maxLocationsPerMinute.',
            );
          }

          options.onProgress?.({
            type: 'throttle',
            phase,
            delayMs: adaptiveDelayMs,
            locationsInWindow: rateLimitState.locationsInWindow,
            maxLocationsPerMinute: maxLocationsPerMinute ?? 0,
            reason: 'rate-limit',
            errorMessage: error.message,
            responseBody: error.responseBody,
            retryAfterHeader: error.retryAfterHeader,
            limitKind: error.limitKind,
          });
          await sleep(adaptiveDelayMs);
          rateLimitState.windowStartedAt = Date.now();
          rateLimitState.locationsInWindow = 0;
          continue;
        }

        throw error;
      }
    }

    rateLimitState.locationsInWindow += chunk.length;
    locationsCompleted += chunk.length;

    for (const forecast of forecasts) {
      const cell = summarizeForecastPoint(forecast, request);
      if (cell) {
        cells.push(cell);
      }
    }

    options.onProgress?.({
      type: 'batch-complete',
      phase,
      batchIndex: index + 1,
      batchCount: chunks.length,
      locationsCompleted,
      totalLocations: coords.length,
      cellsEvaluated: cells.length,
    });
  }

  return { cells, batchCount: chunks.length };
}

function dedupeCoords(coords: ForecastCoord[]): ForecastCoord[] {
  const seen = new Set<string>();
  const deduped: ForecastCoord[] = [];

  for (const coord of coords) {
    const key = coordKey(coord);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(coord);
    }
  }

  return deduped;
}

function selectRefinementCenters(cells: EvaluatedCell[], region: RegionConfig): ForecastCoord[] {
  const candidateCount = region.refinementCandidateCount ?? 20;
  const sorted = [...cells].sort(sortHotspots);
  const hotspotCenters = sorted.filter((cell) => cell.isHotspot);
  const centers = hotspotCenters.length > 0 ? hotspotCenters : sorted;

  return centers.slice(0, candidateCount).map((cell) => ({
    lat: cell.lat,
    lon: cell.lon,
  }));
}

export async function scanRegionForHotspots(
  request: HotspotScanRequest,
  options: HotspotScanOptions = {},
): Promise<HotspotScanResponse> {
  const cacheKey = getCacheKey(request);
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.data,
      scan: {
        ...cached.data.scan,
        cacheHit: true,
      },
    };
  }

  const region = getHotspotRegion(request.regionId);
  const rateLimitState = {
    windowStartedAt: Date.now(),
    locationsInWindow: 0,
  };
  const coarseCoords = generateGrid(region);
  const coarse = await fetchAndEvaluate('coarse', coarseCoords, request, region, rateLimitState, options);
  let refinedCells: EvaluatedCell[] = [];
  let refinedPointsScanned = 0;
  let batchCount = coarse.batchCount;

  if (region.strategy === 'two-pass') {
    const centers = selectRefinementCenters(coarse.cells, region);
    const coarseKeys = new Set(coarseCoords.map(coordKey));
    const refinementCoords = dedupeCoords(
      centers.flatMap((center) => generateRefinementGrid(center, region)),
    ).filter((coord) => !coarseKeys.has(coordKey(coord)));

    refinedPointsScanned = refinementCoords.length;

    if (refinementCoords.length > 0) {
      const refined = await fetchAndEvaluate('refine', refinementCoords, request, region, rateLimitState, options);
      refinedCells = refined.cells;
      batchCount += refined.batchCount;
    }
  }

  const bestCellsByCoord = new Map<string, EvaluatedCell>();

  for (const cell of [...coarse.cells, ...refinedCells]) {
    const key = coordKey(cell);
    const existing = bestCellsByCoord.get(key);
    if (!existing || sortHotspots(cell, existing) < 0) {
      bestCellsByCoord.set(key, cell);
    }
  }

  const hotspots = [...bestCellsByCoord.values()]
    .filter((cell) => cell.isHotspot)
    .sort(sortHotspots)
    .slice(0, request.limit)
    .map(({ isHotspot: _isHotspot, ...cell }) => cell);

  const data: HotspotScanResponse = {
    region,
    scan: {
      forecastHours: request.forecastHours,
      coarsePointsScanned: coarseCoords.length,
      refinedPointsScanned,
      pointsScanned: coarseCoords.length + refinedPointsScanned,
      batchCount,
      generatedAt: toUtcIsoSecond(new Date()),
      cacheHit: false,
    },
    thresholds: {
      tempC: request.tempThresholdC,
      wetBulbC: request.wetBulbThresholdC,
    },
    limit: request.limit,
    hotspots,
  };

  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data,
  });

  return data;
}

export function isHotspotRegionId(value: string): value is HotspotRegionId {
  return value in HOTSPOT_REGIONS;
}
