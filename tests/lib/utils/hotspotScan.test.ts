import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOTSPOT_REGIONS } from '@/lib/config/hotspotRegions';
import { OpenMeteoRateLimitError, type ForecastCoord, type ForecastPoint } from '@/lib/utils/openMeteoForecast';
import {
  chunkCoords,
  clearHotspotScanCache,
  generateGrid,
  generateRefinementGrid,
  scanRegionForHotspots,
  summarizeForecastPoint,
} from '@/lib/utils/hotspotScan';

vi.mock('@/lib/utils/openMeteoForecast', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils/openMeteoForecast')>(
    '@/lib/utils/openMeteoForecast',
  );

  return {
    ...actual,
    fetchOpenMeteoBatch: vi.fn(),
  };
});

const { fetchOpenMeteoBatch } = await import('@/lib/utils/openMeteoForecast');
const fetchOpenMeteoBatchMock = vi.mocked(fetchOpenMeteoBatch);

beforeEach(() => {
  fetchOpenMeteoBatchMock.mockReset();
  clearHotspotScanCache();
});

function makePoint(coord: ForecastCoord, tempC: number, rh: number): ForecastPoint {
  return {
    latitude: coord.lat,
    longitude: coord.lon,
    hourly: {
      time: ['2026-06-16T12:00', '2026-06-16T13:00'],
      temperature_2m: [tempC - 1, tempC],
      relative_humidity_2m: [rh, rh],
    },
  };
}

describe('hotspot scanner', () => {
  it('generates the expected Arabian Peninsula grid', () => {
    expect(generateGrid(HOTSPOT_REGIONS['arabian-peninsula'])).toHaveLength(154);
  });

  it('generates the global coarse grid without a duplicate 180 degree longitude', () => {
    expect(generateGrid(HOTSPOT_REGIONS.global)).toHaveLength(2664);
  });

  it('chunks coordinates by fixed size', () => {
    expect(chunkCoords([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('summarizes forecast points and normalizes UTC timestamps', () => {
    const cell = summarizeForecastPoint(
      makePoint({ lat: 10, lon: 20 }, 42, 55),
      {
        tempThresholdC: 35,
        wetBulbThresholdC: 30,
      },
    );

    expect(cell).toMatchObject({
      lat: 10,
      lon: 20,
      peakTempC: 42,
      peakTempTime: '2026-06-16T13:00:00Z',
      rhAtPeakTemp: 55,
      isHotspot: true,
    });
    expect(cell?.hotHours.length).toBe(2);
  });

  it('creates a 1 degree refinement grid around a candidate', () => {
    const grid = generateRefinementGrid({ lat: 20, lon: 30 }, HOTSPOT_REGIONS.global);

    expect(grid).toContainEqual({ lat: 18, lon: 28 });
    expect(grid).toContainEqual({ lat: 20, lon: 30 });
    expect(grid).toContainEqual({ lat: 22, lon: 32 });
    expect(grid).toHaveLength(25);
  });

  it('runs a two-pass global scan, sorts hotspots, and enforces limit', async () => {
    fetchOpenMeteoBatchMock.mockImplementation(async ({ coords }) =>
      coords.map((coord) => {
        if (coord.lat === 20 && coord.lon === 20) {
          return makePoint(coord, 44, 65);
        }

        if (coord.lat === 21 && coord.lon === 21) {
          return makePoint(coord, 46, 70);
        }

        return makePoint(coord, 25, 35);
      }),
    );

    const result = await scanRegionForHotspots({
      regionId: 'global',
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      limit: 1,
    });

    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0]).toMatchObject({
      lat: 21,
      lon: 21,
      peakTempC: 46,
      rhAtPeakTemp: 70,
    });
    expect(result.scan.coarsePointsScanned).toBe(2664);
    expect(result.scan.refinedPointsScanned).toBeGreaterThan(0);
    expect(result.scan.batchCount).toBeGreaterThan(26);
  });

  it('recovers from Open-Meteo 429s by retrying the same batch', async () => {
    fetchOpenMeteoBatchMock
      .mockRejectedValueOnce(new OpenMeteoRateLimitError({
        message: 'rate limited',
        responseBody: '{"reason":"test"}',
        retryAfterHeader: null,
        retryAfterMs: 1,
        status: 429,
        statusText: 'Too Many Requests',
        limitKind: 'minutely',
      }))
      .mockImplementation(async ({ coords }) =>
        coords.map((coord) => makePoint(coord, 40, 60)),
      );

    const result = await scanRegionForHotspots({
      regionId: 'arabian-peninsula',
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      limit: 1,
    });

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledTimes(5);
    expect(result.hotspots).toHaveLength(1);
  });

  it('fails fast when Open-Meteo reports hourly quota exhaustion', async () => {
    fetchOpenMeteoBatchMock.mockRejectedValueOnce(new OpenMeteoRateLimitError({
      message: 'hourly limited',
      responseBody: '{"reason":"Hourly API request limit exceeded."}',
      retryAfterHeader: null,
      retryAfterMs: 1,
      status: 429,
      statusText: 'Too Many Requests',
      limitKind: 'hourly',
    }));

    await expect(scanRegionForHotspots({
      regionId: 'arabian-peninsula',
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      limit: 1,
    })).rejects.toThrow('hourly API limit is exhausted');
  });
});
