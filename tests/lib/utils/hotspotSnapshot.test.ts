import { describe, expect, it } from 'vitest';
import { validateInhabitedHotspotSnapshot } from '@/lib/utils/hotspotSnapshot';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

function validSnapshot(): InhabitedHotspotSnapshot {
  return {
    schemaVersion: 1,
    label: 'Highest forecast wet-bulb among up to 1,000 grid-prioritized populated places.',
    scan: {
      algorithm: 'grid-cell-v1',
      forecastHours: 24,
      candidateCities: 1,
      populationQualifiedCities: 2,
      gridQualifiedCandidateCities: 1,
      gateCells: 1,
      maxCandidateCities: 1000,
      citiesExcludedByCandidateCap: 0,
      gatingMode: 'grid-cell',
      citiesScanned: 1,
      batchCount: 1,
      generatedAt: '2026-08-01T00:00:00Z',
      cacheHit: false,
    },
    thresholds: {
      tempC: 35,
      wetBulbC: 30,
    },
    minPopulation: 25000,
    limit: 50,
    hotspots: [
      {
        lat: 25,
        lon: 55,
        peakTempC: 39,
        peakTempTime: '2026-08-01T12:00:00Z',
        rhAtPeakTemp: 55,
        peakWetBulbC: 31,
        peakWetBulbTime: '2026-08-01T13:00:00Z',
        hotHours: [
          {
            time: '2026-08-01T13:00:00Z',
            tempC: 38,
            rh: 60,
            wetBulbC: 31,
          },
        ],
        city: {
          name: 'Example City',
          countryCode: 'AE',
          country: 'United Arab Emirates',
          latitude: 25,
          longitude: 55,
          population: 100000,
        },
      },
    ],
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: '2026-08-02T06:00:00Z',
    },
  };
}

describe('validateInhabitedHotspotSnapshot', () => {
  it('accepts schemaVersion 1 grid-cell snapshots', () => {
    expect(validateInhabitedHotspotSnapshot(validSnapshot())).toBe(true);
  });

  it('rejects unversioned legacy radius snapshots', () => {
    const snapshot = validSnapshot() as unknown as Record<string, unknown>;
    delete snapshot.schemaVersion;
    (snapshot.scan as Record<string, unknown>).gateRadiusKm = 600;
    delete (snapshot.scan as Record<string, unknown>).algorithm;

    expect(validateInhabitedHotspotSnapshot(snapshot)).toBe(false);
  });

  it('rejects snapshots not sorted by descending wet bulb', () => {
    const snapshot = validSnapshot();
    snapshot.hotspots.unshift({
      ...snapshot.hotspots[0],
      peakWetBulbC: 20,
      city: {
        ...snapshot.hotspots[0].city,
        name: 'Cooler City',
      },
    });

    expect(validateInhabitedHotspotSnapshot(snapshot)).toBe(false);
  });
});
