import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopulatedCity } from '@/lib/types/hotspots';
import {
  OpenMeteoTransientError,
  type ForecastCoord,
  type ForecastPoint,
} from '@/lib/utils/openMeteoForecast';
import { scanPopulatedPlacesForHotspots } from '@/lib/utils/inhabitedHotspotScan';

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
});

function makeCity(name: string, population: number, lat: number, lon: number): PopulatedCity {
  return {
    name,
    countryCode: 'US',
    latitude: lat,
    longitude: lon,
    population,
  };
}

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

describe('inhabited hotspot scanner', () => {
  it('scans only cities above the population threshold and ranks by wet bulb', async () => {
    const cities = [
      makeCity('Below threshold', 25000, 1, 1),
      makeCity('Hot but drier', 100000, 2, 2),
      makeCity('Wetter winner', 50000, 3, 3),
    ];

    fetchOpenMeteoBatchMock.mockImplementation(async ({ coords }) =>
      coords.map((coord) => {
        if (coord.lat === 3) {
          return makePoint(coord, 42, 78);
        }

        return makePoint(coord, 45, 50);
      }),
    );

    const result = await scanPopulatedPlacesForHotspots(cities, {
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      minPopulation: 25000,
      limit: 1,
    });

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledWith({
      coords: [
        { lat: 2, lon: 2 },
        { lat: 3, lon: 3 },
      ],
      forecastHours: 2,
      landFocused: true,
    });
    expect(result.scan.candidateCities).toBe(2);
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0].city.name).toBe('Wetter winner');
  });

  it('retries transient Open-Meteo overloads for the same city batch', async () => {
    const cities = [
      makeCity('Hot city', 100000, 2, 2),
    ];

    fetchOpenMeteoBatchMock
      .mockRejectedValueOnce(new OpenMeteoTransientError({
        message: 'Open-Meteo forecast request failed (503 Service Unavailable)',
        responseBody: '{"reason":"The service is overloaded","error":true}',
        retryAfterHeader: null,
        retryAfterMs: 1,
        status: 503,
        statusText: 'Service Unavailable',
      }))
      .mockImplementation(async ({ coords }) => coords.map((coord) => makePoint(coord, 42, 78)));

    const result = await scanPopulatedPlacesForHotspots(cities, {
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      minPopulation: 25000,
      limit: 1,
    });

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledTimes(2);
    expect(result.hotspots).toHaveLength(1);
  });

  it('uses gate cells and candidate caps before exact city scans', async () => {
    const cities = [
      makeCity('Large near gate', 200000, 10, 10),
      makeCity('Small near gate', 50000, 10.2, 10.2),
      makeCity('Far city', 300000, -20, -20),
    ];

    fetchOpenMeteoBatchMock.mockImplementation(async ({ coords }) =>
      coords.map((coord) => makePoint(coord, 41, 70)),
    );

    const result = await scanPopulatedPlacesForHotspots(
      cities,
      {
        forecastHours: 2,
        tempThresholdC: 35,
        wetBulbThresholdC: 30,
        minPopulation: 25000,
        limit: 10,
      },
      {
        gateCells: [{
          lat: 10,
          lon: 10,
          peakTempC: 34,
          peakTempTime: '2026-06-16T12:00:00Z',
          rhAtPeakTemp: 70,
          peakWetBulbC: 28,
          peakWetBulbTime: '2026-06-16T12:00:00Z',
          hotHours: [],
        }],
        gateRadiusKm: 100,
        maxCandidateCities: 1,
      },
    );

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledWith({
      coords: [{ lat: 10, lon: 10 }],
      forecastHours: 2,
      landFocused: true,
    });
    expect(result.scan.populationQualifiedCities).toBe(3);
    expect(result.scan.candidateCities).toBe(1);
    expect(result.scan.gateCells).toBe(1);
    expect(result.hotspots[0].city.name).toBe('Large near gate');
  });

  it('resumes completed city batches from checkpoint without re-fetching them', async () => {
    const checkpointPath = path.join(
      process.cwd(),
      '.cache',
      `inhabited-hotspot-test-${Date.now()}-${Math.random()}.json`,
    );
    const cities = [
      makeCity('Batch one', 300000, 1, 1),
      makeCity('Batch two', 200000, 2, 2),
    ];

    fetchOpenMeteoBatchMock
      .mockImplementationOnce(async ({ coords }) =>
        coords.map((coord) => makePoint(coord, 41, 70)),
      )
      .mockRejectedValueOnce(new Error('stop after checkpoint'));

    await expect(scanPopulatedPlacesForHotspots(
      cities,
      {
        forecastHours: 2,
        tempThresholdC: 35,
        wetBulbThresholdC: 30,
        minPopulation: 25000,
        limit: 10,
      },
      {
        batchSize: 1,
        checkpointPath,
      },
    )).rejects.toThrow('stop after checkpoint');

    fetchOpenMeteoBatchMock.mockReset();
    fetchOpenMeteoBatchMock.mockImplementation(async ({ coords }) =>
      coords.map((coord) => makePoint(coord, 42, 75)),
    );

    const result = await scanPopulatedPlacesForHotspots(
      cities,
      {
        forecastHours: 2,
        tempThresholdC: 35,
        wetBulbThresholdC: 30,
        minPopulation: 25000,
        limit: 10,
      },
      {
        batchSize: 1,
        checkpointPath,
      },
    );

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledTimes(1);
    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledWith({
      coords: [{ lat: 2, lon: 2 }],
      forecastHours: 2,
      landFocused: true,
    });
    expect(result.hotspots.map((hotspot) => hotspot.city.name).sort()).toEqual([
      'Batch one',
      'Batch two',
    ]);
    await expect(fs.access(checkpointPath)).rejects.toThrow();
  });
});
