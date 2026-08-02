import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluatedHotspotCell, PopulatedCity } from '@/lib/types/hotspots';
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

function makeEvaluatedCell(
  lat: number,
  lon: number,
  peakTempC: number,
  peakWetBulbC: number,
  sourceStepDeg = 1,
): EvaluatedHotspotCell {
  return {
    lat,
    lon,
    peakTempC,
    peakTempTime: '2026-06-16T12:00:00Z',
    rhAtPeakTemp: 70,
    peakWetBulbC,
    peakWetBulbTime: '2026-06-16T12:00:00Z',
    hotHours: [],
    sourceStepDeg,
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

  it('grid-gates cities in warm cells and excludes cities in cool cells', async () => {
    const cities = [
      makeCity('Warm cell city', 100000, 10.2, 10.2),
      makeCity('Cool cell city', 200000, -10.2, -10.2),
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
        gatingMode: 'grid-cell',
        evaluatedCells: [
          makeEvaluatedCell(10, 10, 30, 24),
          makeEvaluatedCell(-10, -10, 29, 25),
        ],
      },
    );

    expect(fetchOpenMeteoBatchMock).toHaveBeenCalledWith({
      coords: [{ lat: 10.2, lon: 10.2 }],
      forecastHours: 2,
      landFocused: true,
    });
    expect(result.scan.gatingMode).toBe('grid-cell');
    expect(result.scan.gateCells).toBe(1);
    expect(result.scan.gridQualifiedCandidateCities).toBe(1);
  });

  it('includes cities in a neighboring cell, including across longitude wraparound', async () => {
    const cities = [
      makeCity('Neighbor city', 100000, 1.4, 1.4),
      makeCity('Date line city', 90000, 0, -179.4),
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
        gatingMode: 'grid-cell',
        evaluatedCells: [
          makeEvaluatedCell(0, 0, 31, 24),
          makeEvaluatedCell(0, 179.5, 29, 26),
        ],
      },
    );

    expect(result.scan.gridQualifiedCandidateCities).toBe(2);
    expect(fetchOpenMeteoBatchMock.mock.calls[0][0].coords).toEqual(expect.arrayContaining([
      { lat: 1.4, lon: 1.4 },
      { lat: 0, lon: -179.4 },
    ]));
  });

  it('caps grid candidates after sorting by gating wet bulb before population', async () => {
    const cities = [
      makeCity('Larger but less humid', 500000, 20, 20),
      makeCity('Smaller humid winner', 50000, 0, 0),
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
        gatingMode: 'grid-cell',
        evaluatedCells: [
          makeEvaluatedCell(20, 20, 35, 26),
          makeEvaluatedCell(0, 0, 31, 28),
        ],
        maxCandidateCities: 1,
      },
    );

    expect(fetchOpenMeteoBatchMock.mock.calls[0][0].coords).toEqual([{ lat: 0, lon: 0 }]);
    expect(result.scan.populationQualifiedCities).toBe(2);
    expect(result.scan.gridQualifiedCandidateCities).toBe(2);
    expect(result.scan.candidateCities).toBe(1);
    expect(result.scan.citiesExcludedByCandidateCap).toBe(1);
    expect(result.scan.citiesScanned).toBe(1);
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

  it('changes the checkpoint key when gating mode or selected city metadata changes', async () => {
    const checkpointPath = path.join(
      process.cwd(),
      '.cache',
      `inhabited-hotspot-key-test-${Date.now()}-${Math.random()}.json`,
    );
    const request = {
      forecastHours: 2,
      tempThresholdC: 35,
      wetBulbThresholdC: 30,
      minPopulation: 25000,
      limit: 10,
    };
    const cities = [
      makeCity('Batch one', 300000, 1, 1),
      makeCity('Batch two', 200000, 2, 2),
    ];
    const captureCheckpointKey = async (
      scanCities: PopulatedCity[],
      options: Parameters<typeof scanPopulatedPlacesForHotspots>[2],
    ): Promise<string> => {
      fetchOpenMeteoBatchMock.mockReset();
      fetchOpenMeteoBatchMock
        .mockImplementationOnce(async ({ coords }) =>
          coords.map((coord) => makePoint(coord, 41, 70)),
        )
        .mockRejectedValueOnce(new Error('stop after checkpoint'));
      await expect(scanPopulatedPlacesForHotspots(scanCities, request, {
        ...options,
        batchSize: 1,
        checkpointPath,
      })).rejects.toThrow('stop after checkpoint');
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as { key: string };
      return checkpoint.key;
    };

    const radiusKey = await captureCheckpointKey(cities, { gatingMode: 'radius' });
    const gridKey = await captureCheckpointKey(cities, {
      gatingMode: 'grid-cell',
      evaluatedCells: [makeEvaluatedCell(1.5, 1.5, 31, 27, 5)],
    });
    const changedCitiesKey = await captureCheckpointKey([{
      ...cities[0],
      country: 'United States',
      admin1: 'Different display region',
    }, cities[1]], {
      gatingMode: 'grid-cell',
      evaluatedCells: [makeEvaluatedCell(1.5, 1.5, 31, 27, 5)],
    });

    expect(gridKey).not.toBe(radiusKey);
    expect(changedCitiesKey).not.toBe(gridKey);
    await fs.rm(checkpointPath, { force: true });
  });
});
